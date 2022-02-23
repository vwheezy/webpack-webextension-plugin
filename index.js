const path = require('path')
const { promisify } = require('util')
const WebSocket = require('ws')
const compileTemplate = require('./utils/compile-template')
const manifestUtils = require('./manifest-utils')
const vendors = require('./vendors.json')

const clientPath = 'webextension-toolbox/client.js'
const manifestName = 'manifest.json'

class WebextensionPlugin {
  constructor ({
    port = 35729,
    host = 'localhost',
    reconnectTime = 3000,
    autoreload = true,
    vendor = 'chrome',
    manifestDefaults = {},
    quiet = false,
    skipManifestValidation = false
  } = {}) {
    // Apply Settings
    this.port = port
    this.host = host
    this.autoreload = autoreload
    this.reconnectTime = reconnectTime
    this.vendor = vendor
    this.manifestDefaults = manifestDefaults
    this.quiet = quiet
    this.skipManifestValidation = skipManifestValidation

    // Set some defaults
    this.server = null
    this.isWatching = false
    this.manifestChanged = true
    this.clientAdded = false
    this.startTime = Date.now()
  }

  /**
   * Install plugin (install hooks)
   *
   * @param {Object} compiler
   */
  apply (compiler) {
    const { name } = this.constructor
    const { inputFileSystem } = compiler
    this.readFile = promisify(inputFileSystem.readFile.bind(inputFileSystem))
    this.sources = compiler.webpack.sources
    this.cleanPlugin = compiler.webpack.CleanPlugin
    compiler.hooks.watchRun.tapPromise(name, this.watchRun.bind(this))
    compiler.hooks.compilation.tap(name, this.compilation.bind(this))
    compiler.hooks.make.tapPromise(name, this.make.bind(this))
    compiler.hooks.afterCompile.tap(name, this.afterCompile.bind(this))
    compiler.hooks.done.tap(name, this.done.bind(this))
  }

  /**
   * Webpack watchRun hook
   *
   * @param {Object} watching
   */
  watchRun (watching) {
    this.isWatching = true
    this.detectManifestModification(watching)
    return this.startServer()
  }

  /**
   * Webpack compilation hook
   *
   * @param {Object} compilation
   */
  compilation (compilation) {
    this.keepFiles(compilation)
  }

  /**
   * Webpack make hook
   *
   * @param {Object} compilation
   */
  make (compilation) {
    return Promise.all([
      this.addClient(compilation),
      this.addManifest(compilation)
    ])
  }

  /**
   * Webpack afteCompile hook
   *
   * @param {Object} compilation
   */
  afterCompile (compilation) {
    return this.watchManifest(compilation)
  }

  /**
   * Add manifest to the filesDependencies
   *
   * @param {Object} compilation
   */
  watchManifest (compilation) {
    compilation.fileDependencies.add(
      path.join(compilation.options.context, manifestName)
    )
  }

  /**
   * Webpack done hook
   *
   * @param {Object} stats
   */
  done (stats) {
    this.reloadExtensions(stats)
  }

  /**
   * Prevents deletion of manifest.json and client.js files by clean plugin
   *
   * @param {Object} compilation
   */
  keepFiles (compilation) {
    if (this.cleanPlugin) {
      const keepPredicate = (asset) => asset === manifestName ||
        (asset === clientPath && this.autoreload && this.isWatching)
      this.cleanPlugin.getCompilationHooks(compilation).keep.tap(this.constructor.name, keepPredicate)
    }
  }

  /**
   * Detect changed files
   *
   * @param {Object} watching
   */
  detectManifestModification (watching) {
    if (watching.modifiedFiles) {
      const manifestFile = path.join(watching.options.context, manifestName)
      this.manifestChanged = watching.modifiedFiles.has(manifestFile)
    }
  }

  /**
   * Start websocket server
   * on watch mode
   */
  startServer () {
    return new Promise((resolve, reject) => {
      if (!this.autoreload || !this.isWatching || this.server) return resolve()
      const { host, port } = this
      this.server = new WebSocket.Server({ port }, () => {
        this.log(`listens on ws://${host}:${port}`)
        resolve()
      })
      this.server.on('error', reject)
      this.nofiyExtension = data => {
        this.server.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data))
          }
        })
      }
    })
  }

  /**
   * Namespaced logger
   *
   * @param {*} args
   */
  log (...args) {
    if (!this.quiet) {
      console.log('webpack-webextension-plugin', ...args)
    }
  }

  /**
   * Add the client script to assets
   * when autoreload enabled and is watching
   *
   * @param {Object} compilation
   */
  async addClient (compilation) {
    if (this.autoreload && this.isWatching && !this.clientAdded) {
      // Add client to extension. We will includes this
      // as a background script in the manifest.json later.
      const client = await this.compileClient()
      compilation.emitAsset(clientPath, new this.sources.RawSource(client))
      this.clientAdded = true
    }
  }

  /**
   * Compile the client only once
   * and add it to the assets output
   */
  async compileClient () {
    // Only compile client once
    if (this.client) return this.client

    // Get the client as string
    const clientPath = path.resolve(__dirname, 'client.js')
    const clientBuffer = await this.readFile(clientPath)

    // Inject settings
    this.client = compileTemplate(clientBuffer.toString(), {
      port: this.port,
      host: this.host,
      reconnectTime: this.reconnectTime
    })

    return this.client
  }

  /**
   * Compile manifest and add it
   * to the asset ouput
   *
   * @param {Object} compilation
   */
  async addManifest (compilation) {
    if (this.manifestChanged) {
      // Load manifest
      const manifestPath = path.join(compilation.options.context, manifestName)
      const manifestBuffer = await this.readFile(manifestPath)
      let manifest
      // Convert to JSON
      try {
        manifest = JSON.parse(manifestBuffer)
      } catch (error) {
        throw new Error(`Could not parse ${manifestName}`)
      }

      manifest = {
            ...this.manifestDefaults,
        ...manifest
      }

      // Tranform __chrome__key -> key
      manifest = manifestUtils.transformVendorKeys(manifest, this.vendor)

      // Validate manifest.json syntax
      // The plugin offers an option to skip the validation because
      // the syntax of e.g. MV3 is still evolving. We don't want to make the whole
      // plugin useless by blocking the whole compilation due to an obsolete validation.
      if (!this.skipManifestValidation) {
        await manifestUtils.validate(manifest)
      }

      // Add client
      if (this.autoreload && this.isWatching) {
        const result = await manifestUtils.addBackgroundscript(manifest, 'webextension-toolbox/client.js', compilation.options.context)
        manifest = result.manifest
        if (result.backgroundPagePath) {
          compilation.emitAsset(result.backgroundPagePath, new this.sources.RawSource(result.backgroundPageStr))
        }
      }

      // Create webpack file entry
      const manifestStr = JSON.stringify(manifest, null, 2)
      compilation.emitAsset(manifestName, new this.sources.RawSource(manifestStr))
    }
  }

  /**
   * Send message to extensions with
   * changed files
   *
   * @param {Object} stats
   */
  reloadExtensions (stats) {
    // Skip in normal mode
    if (!this.server || !this.isWatching) return

    // Get changed files since last compile
    const changedFiles = this.extractChangedFiles(stats.compilation)
    if (changedFiles.length) {
      this.log('reloading extension...')
      this.nofiyExtension({
        action: 'reload',
        changedFiles
      })
    }
  }

  /**
   * Get the changed files since
   * last compilation
   *
   * @param {Object} compilation
   */
  extractChangedFiles ({ emittedAssets }) {
    return emittedAssets ? Array.from(emittedAssets) : []
  }
}

// Expose the vendors
WebextensionPlugin.vendors = vendors

module.exports = WebextensionPlugin

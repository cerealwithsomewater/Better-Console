(function (globalScope) {
  'use strict';

  /**
   * BetterConsole
   * Lightweight console enhancer for browsers and Node.
   * - Timestamps and level labels
   * - Colors (CSS in browser, ANSI in Node)
   * - Namespaced loggers with include/exclude patterns
   * - Runtime level control
   * - In-memory ring buffer of recent logs
   * - Install/restore to wrap the global console
   */

  var isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  var hasConsole = typeof globalScope.console !== 'undefined';
  if (!hasConsole) {
    try { globalScope.console = {}; hasConsole = true; } catch (_) { /* ignore */ }
  }

  var LEVELS = {
    trace: 10,
    debug: 20,
    log: 30,
    info: 40,
    warn: 50,
    error: 60
  };

  var LEVEL_COLORS_BROWSER = {
    trace: '#b07fff',
    debug: '#6b7280',
    log: '#475569',
    info: '#2563eb',
    warn: '#b45309',
    error: '#dc2626'
  };

  var ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    colors: {
      gray: '\x1b[90m',
      blue: '\x1b[34m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      green: '\x1b[32m'
    }
  };

  var LEVEL_COLORS_NODE = {
    trace: ANSI.colors.magenta,
    debug: ANSI.colors.gray,
    log: ANSI.colors.green,
    info: ANSI.colors.blue,
    warn: ANSI.colors.yellow,
    error: ANSI.colors.red
  };

  function noop() {}

  var LEVEL_ICONS = {
    trace: '🔍',
    debug: '🐛',
    log: '📝',
    info: 'ℹ️',
    warn: '⚠️',
    error: '⛔'
  };

  var DEFAULT_CONFIG = {
    level: 'debug',
    namespaces: '*',
    enableColors: true,
    showTime: true,
    showNamespace: true,
    showIcons: true,
    captureStack: false,
    overlay: false,
    overlayLimit: 500,
    stickyInstall: true,
    guardIntervalMs: 2000,
    injectNewWindows: true,
    printToNative: true,
    windowTransport: false,
    windowTransportTarget: '*',
    windowListener: false,
    windowListenerOrigins: ['*'],
    bufferSize: 500,
    autoInstall: true
  };

  var state = {
    installed: false,
    original: {},
    config: clone(DEFAULT_CONFIG),
    levelWeight: LEVELS[DEFAULT_CONFIG.level] || LEVELS.debug,
    includePatterns: [createWildcardRegex('*')],
    excludePatterns: [],
    buffer: [],
    transports: [],
    paused: false,
    onceKeys: Object.create(null),
    nsLevelRules: [],
    sampleRules: [],
    redactorFn: null,
    wrappers: {},
    guardTimer: null,
    openPatched: false,
    originalOpen: null
    , originalFetch: null
    , originalXHR: null
    , originalWorker: null
    , networkHooked: false
    , workerHooked: false
    , messageListenerInstalled: false
    , messageListener: null
    , handlingRemote: false
  };

  /** Public API object exposed as globalScope.BetterConsole */
  var BetterConsole = {
    version: '0.1.0',
    install: install,
    restore: restore,
    setLevel: setLevel,
    getLevel: function () { return state.config.level; },
    updateConfig: updateConfig,
    enableNamespaces: enableNamespaces,
    isNamespaceEnabled: isNamespaceEnabled,
    createLogger: createLogger,
    getBuffer: function () { return state.buffer.slice(); },
    clearBuffer: function () { state.buffer.length = 0; },
    getConfig: function () { return clone(state.config); },
    installed: function () { return state.installed; },
    addTransport: addTransport,
    removeTransport: removeTransport,
    createHttpTransport: createHttpTransport,
    pause: function () { state.paused = true; },
    resume: function () { state.paused = false; },
    isPaused: function () { return state.paused; },
    resetOnce: function () { state.onceKeys = Object.create(null); },
    captureGlobalErrors: captureGlobalErrors,
    releaseGlobalErrors: releaseGlobalErrors,
    setNamespaceLevels: setNamespaceLevels,
    setSampling: setSampling,
    setRedactor: setRedactor,
    exportBuffer: exportBuffer,
    importBuffer: importBuffer
    , showOverlay: showOverlay
    , hideOverlay: hideOverlay
    , toggleOverlay: toggleOverlay
    , installInto: installInto
    , injectAllFrames: injectAllFrames
    , createWindowTransport: createWindowTransport
    , startWindowListener: startWindowListener
    , stopWindowListener: stopWindowListener
    , hookNetwork: hookNetwork
    , hookWorker: hookWorker
    , reportError: reportError
    , captureNodeErrors: captureNodeErrors
  };

  // Expose early so apps can opt-out of auto-install by setting flags before execution ends
  Object.defineProperty(globalScope, 'BetterConsole', {
    value: BetterConsole,
    configurable: true,
    writable: true,
    enumerable: false
  });

  // Apply environment overrides and optionally auto-install
  try {
    var overrides = readEnvironmentOverrides();
    applyOverrides(overrides);
    if (state.config.autoInstall) {
      install();
    }
  } catch (_) {
    // Swallow to avoid breaking host apps during bootstrap.
  }

  /**
   * Install wrappers over the global console methods.
   */
  function install(config) {
    if (state.installed) return;
    if (config && typeof config === 'object') {
      applyOverrides(config);
    }

    // Capture original methods
    var methods = ['debug', 'log', 'info', 'warn', 'error', 'trace', 'group', 'groupCollapsed', 'groupEnd', 'assert', 'table'];
    for (var i = 0; i < methods.length; i++) {
      var m = methods[i];
      var original = (globalScope.console && typeof globalScope.console[m] === 'function')
        ? globalScope.console[m]
        : (globalScope.console && typeof globalScope.console.log === 'function' ? globalScope.console.log : noop);
      state.original[m] = original;
    }

    // Wrap
    function mark(fn) { try { Object.defineProperty(fn, '__bc', { value: true }); } catch (_) {} return fn; }
    state.wrappers.debug = mark(createConsoleWrapper('debug'));
    state.wrappers.log = mark(createConsoleWrapper('log'));
    state.wrappers.info = mark(createConsoleWrapper('info'));
    state.wrappers.warn = mark(createConsoleWrapper('warn'));
    state.wrappers.error = mark(createConsoleWrapper('error'));
    state.wrappers.trace = mark(createConsoleWrapper('trace'));
    state.wrappers.group = mark(createGroupWrapper(false));
    state.wrappers.groupCollapsed = mark(createGroupWrapper(true));
    globalScope.console.debug = state.wrappers.debug;
    globalScope.console.log = state.wrappers.log;
    globalScope.console.info = state.wrappers.info;
    globalScope.console.warn = state.wrappers.warn;
    globalScope.console.error = state.wrappers.error;
    globalScope.console.trace = state.wrappers.trace;
    globalScope.console.group = state.wrappers.group;
    globalScope.console.groupCollapsed = state.wrappers.groupCollapsed;
    globalScope.console.groupEnd = function () {
      // passthrough
      state.original.groupEnd.apply(globalScope.console, arguments);
    };

    globalScope.console.assert = function () {
      var args = Array.prototype.slice.call(arguments);
      var condition = args.shift();
      if (!!condition) return;
      emit('error', 'global', ['Assertion failed:'].concat(args), null);
    };

    globalScope.console.table = function () {
      var args = toArray(arguments);
      var timeText = formatTime(new Date());
      var prefix = buildPlainPrefix('log', timeText, '');
      if (!state.paused && typeof state.original.log === 'function') state.original.log(prefix + ' TABLE');
      if (!state.paused && typeof state.original.table === 'function') state.original.table.apply(globalScope.console, args);
      addToBuffer({ time: new Date().toISOString(), level: 'log', namespace: 'global', preview: 'TABLE ' + summarizeTable(args[0]) });
    };

    if (isBrowser && state.config.overlay) {
      ensureOverlay();
      bindOverlayHotkey();
    }

    if (isBrowser && state.config.stickyInstall) startGuard();
    if (isBrowser && state.config.injectNewWindows) patchWindowOpen();

    state.installed = true;
  }

  /**
   * Restore original console methods.
   */
  function restore() {
    if (!state.installed) return;
    var methods = Object.keys(state.original);
    for (var i = 0; i < methods.length; i++) {
      var m = methods[i];
      try {
        globalScope.console[m] = state.original[m];
      } catch (_) {
        // No-op
      }
    }
    state.installed = false;
    stopGuard();
    unpatchWindowOpen();
  }

  /**
   * Update the minimum level for logs to be emitted.
   */
  function setLevel(levelName) {
    if (!LEVELS.hasOwnProperty(levelName)) return;
    state.config.level = levelName;
    state.levelWeight = LEVELS[levelName];
  }

  /**
   * Shallow update of configuration. Recomputes derived fields and patterns.
   */
  function updateConfig(partial) {
    if (!partial || typeof partial !== 'object') return;
    applyOverrides(partial);
  }

  /**
   * Configure allowed/blocked namespaces using a pattern string.
   * Example: "app:*,db,-app:verbose" ("," or space separated). "*" allows all.
   */
  function enableNamespaces(patternString) {
    if (typeof patternString !== 'string' || patternString.trim() === '') {
      state.includePatterns = [createWildcardRegex('*')];
      state.excludePatterns = [];
      state.config.namespaces = '*';
      return;
    }

    var tokens = patternString.replace(/\s+/g, ',').split(',').filter(Boolean);
    var includes = [];
    var excludes = [];
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i].trim();
      if (!token) continue;
      if (token[0] === '-') {
        excludes.push(createWildcardRegex(token.slice(1)));
      } else {
        includes.push(createWildcardRegex(token));
      }
    }
    if (includes.length === 0) {
      includes.push(createWildcardRegex('*'));
    }
    state.includePatterns = includes;
    state.excludePatterns = excludes;
    state.config.namespaces = patternString;
  }

  /**
   * True if a namespace passes the current include/exclude filters.
   */
  function isNamespaceEnabled(namespace) {
    var ns = typeof namespace === 'string' && namespace.length ? namespace : 'global';
    var i, re;
    for (i = 0; i < state.excludePatterns.length; i++) {
      re = state.excludePatterns[i];
      if (re.test(ns)) return false;
    }
    var anyIncluded = false;
    for (i = 0; i < state.includePatterns.length; i++) {
      re = state.includePatterns[i];
      if (re.test(ns)) {
        anyIncluded = true;
        break;
      }
    }
    return anyIncluded;
  }

  /**
   * Create a namespaced logger that honors current level and namespace filters.
   */
  function createLogger(namespace, options) {
    var ns = typeof namespace === 'string' && namespace.length ? namespace : 'global';
    var colorOverride = options && options.color ? options.color : null;
    var timers = {};
    var counters = {};
    var baseContext = (options && typeof options.context === 'object') ? options.context : null;
    return {
      trace: function () { emit('trace', ns, arguments, colorOverride); },
      debug: function () { emit('debug', ns, arguments, colorOverride); },
      log: function () { emit('log', ns, arguments, colorOverride); },
      info: function () { emit('info', ns, arguments, colorOverride); },
      warn: function () { emit('warn', ns, arguments, colorOverride); },
      error: function () { emit('error', ns, arguments, colorOverride); },
      withContext: function (ctx) {
        var merged = Object.assign({}, baseContext || {}, ctx || {});
        return createLogger(ns, { color: colorOverride, context: merged });
      },
      once: function (key) {
        var k = ns + '|' + String(key);
        if (state.onceKeys[k]) return;
        state.onceKeys[k] = true;
        var args = toArray(arguments).slice(1);
        emit('info', ns, args, colorOverride);
      },
      count: function (label) {
        var k = String(label || 'default');
        counters[k] = (counters[k] || 0) + 1;
        emit('info', ns, ['count ' + k + ': ' + counters[k]], colorOverride);
      },
      countReset: function (label) {
        var k = String(label || 'default');
        counters[k] = 0;
        emit('info', ns, ['countReset ' + k + ': 0'], colorOverride);
      },
      group: function () { groupWithNamespace(false, ns, colorOverride, arguments); },
      groupCollapsed: function () { groupWithNamespace(true, ns, colorOverride, arguments); },
      groupEnd: function () { state.original.groupEnd(); },
      time: function (label) {
        var key = String(label || 'default');
        timers[key] = nowMs();
      },
      timeEnd: function (label) {
        var key = String(label || 'default');
        var start = timers[key];
        if (start == null) return;
        var dur = nowMs() - start;
        delete timers[key];
        emit('info', ns, ['Timer ' + key + ': ' + dur.toFixed(1) + 'ms'], colorOverride);
      }
    };
  }

  /**
   * Build per-method console wrapper used when installed globally.
   */
  function createConsoleWrapper(levelName) {
    return function () {
      emit(levelName, 'global', arguments, null);
    };
  }

  function createGroupWrapper(collapsed) {
    return function () {
      groupWithNamespace(!!collapsed, 'global', null, arguments);
    };
  }

  /**
   * Core emit that formats prefix, writes via original console, and buffers.
   */
  function emit(levelName, namespace, argsLike, colorOverride) {
    if (!LEVELS.hasOwnProperty(levelName)) levelName = 'log';
    var nsWeight = getEffectiveLevelWeight(namespace);
    if (LEVELS[levelName] < nsWeight) return;
    if (!shouldPassSampling(namespace)) return;
    if (!isNamespaceEnabled(namespace)) return;

    var originalMethod = state.original[levelName] || state.original.log || globalScope.console.log;
    var time = new Date();
    var timeText = formatTime(time);
    var levelLabel = levelName.toUpperCase();
    var nsLabel = namespace && namespace !== 'global' ? '[' + namespace + ']' : '';

    var sanitized = applyRedaction(argsLike, levelName, namespace);
    var formattedArgs;
    if (!state.paused && state.config.printToNative) {
      try {
        if (state.config.enableColors && isBrowser) {
          var browserPrefix = buildBrowserPrefix(levelName, timeText, nsLabel, colorOverride);
          formattedArgs = [browserPrefix.fmt].concat(browserPrefix.css, sanitized);
          originalMethod.apply(globalScope.console, formattedArgs);
        } else if (!isBrowser && state.config.enableColors) {
          var nodePrefix = buildNodePrefix(levelName, timeText, nsLabel, colorOverride);
          var out = [nodePrefix].concat(sanitized);
          originalMethod.apply(globalScope.console, out);
        } else {
          var plainPrefix = buildPlainPrefix(levelName, timeText, nsLabel);
          var all = [plainPrefix].concat(sanitized);
          originalMethod.apply(globalScope.console, all);
        }
      } catch (_) { /* swallow native console failures */ }
    }

    // Buffer preview entry
    var entry = {
      time: time.toISOString(),
      level: levelName,
      namespace: namespace,
      preview: buildPreview(sanitized),
      args: sanitized
    };
    var stack = maybeCaptureStack(levelName);
    if (stack) entry.stack = stack;
    notifyTransports(entry);
    if (isBrowser && state.config.windowTransport && !state.handlingRemote) try { window.postMessage({ __betterConsole: true, entry: entry }, state.config.windowTransportTarget || '*'); } catch (_) {}
    if (isBrowser && state.config.overlay) overlayAppend(entry);
    addToBuffer({ time: entry.time, level: entry.level, namespace: entry.namespace, preview: entry.preview });
  }

  function groupWithNamespace(collapsed, namespace, colorOverride, argsLike) {
    var timeText = formatTime(new Date());
    var nsLabel = namespace && namespace !== 'global' ? '[' + namespace + ']' : '';
    if (state.paused) return;
    if (state.config.enableColors && isBrowser) {
      var prefix = buildBrowserPrefix('log', timeText, nsLabel, colorOverride);
      var arr = [prefix.fmt].concat(prefix.css, toArray(argsLike));
      var method = collapsed ? state.original.groupCollapsed : state.original.group;
      method.apply(globalScope.console, arr);
    } else if (!isBrowser && state.config.enableColors) {
      var node = buildNodePrefix('log', timeText, nsLabel, colorOverride);
      var arr2 = [node].concat(toArray(argsLike));
      var method2 = collapsed ? state.original.groupCollapsed : state.original.group;
      method2.apply(globalScope.console, arr2);
    } else {
      var plain = buildPlainPrefix('log', timeText, nsLabel);
      var arr3 = [plain].concat(toArray(argsLike));
      var method3 = collapsed ? state.original.groupCollapsed : state.original.group;
      method3.apply(globalScope.console, arr3);
    }
  }

  function buildBrowserPrefix(levelName, timeText, nsLabel, colorOverride) {
    var lvlColor = colorOverride || LEVEL_COLORS_BROWSER[levelName] || '#1f2937';
    var timeCss = 'color:#9ca3af';
    var lvlCss = 'color:' + lvlColor + ';font-weight:600';
    var nsCss = 'color:#6b7280';
    var iconCss = 'color:' + lvlColor;
    var fmtParts = [];
    var css = [];
    if (state.config.showTime) { fmtParts.push('%c[' + timeText + ']'); css.push(timeCss); }
    if (state.config.showIcons) { fmtParts.push('%c' + (LEVEL_ICONS[levelName] || '')); css.push(iconCss); }
    fmtParts.push('%c[' + levelName.toUpperCase() + ']'); css.push(lvlCss);
    if (state.config.showNamespace && nsLabel) { fmtParts.push('%c' + nsLabel); css.push(nsCss); }
    return { fmt: fmtParts.join(' '), css: css };
  }

  function buildNodePrefix(levelName, timeText, nsLabel, colorOverride) {
    var nodeColor = colorOverride || LEVEL_COLORS_NODE[levelName] || '';
    var parts = [];
    if (state.config.showTime) parts.push('[' + timeText + ']');
    parts.push('[' + levelName.toUpperCase() + ']');
    if (state.config.showNamespace && nsLabel) parts.push(nsLabel);
    var icon = state.config.showIcons ? (LEVEL_ICONS[levelName] ? LEVEL_ICONS[levelName] + ' ' : '') : '';
    return nodeColor + icon + parts.join(' ') + ANSI.reset;
  }

  function buildPlainPrefix(levelName, timeText, nsLabel) {
    var parts = [];
    if (state.config.showTime) parts.push('[' + timeText + ']');
    parts.push('[' + levelName.toUpperCase() + ']');
    if (state.config.showNamespace && nsLabel) parts.push(nsLabel);
    var icon = state.config.showIcons ? (LEVEL_ICONS[levelName] ? LEVEL_ICONS[levelName] + ' ' : '') : '';
    return icon + parts.join(' ');
  }

  function addToBuffer(entry) {
    state.buffer.push(entry);
    var overflow = state.buffer.length - state.config.bufferSize;
    if (overflow > 0) {
      state.buffer.splice(0, overflow);
    }
  }

  function buildPreview(argsLike) {
    try {
      var args = toArray(argsLike);
      var out = [];
      for (var i = 0; i < args.length; i++) {
        out.push(stringifyForPreview(args[i]));
        if (out.join(' ').length > 300) break;
      }
      return out.join(' ');
    } catch (_) {
      return '[unavailable]';
    }
  }

  function toArray(argsLike) {
    return Array.prototype.slice.call(argsLike);
  }

  function applyRedaction(argsLike, levelName, namespace) {
    var arr = toArray(argsLike);
    if (typeof state.redactorFn !== 'function') return arr;
    try {
      var out = state.redactorFn(arr, { level: levelName, namespace: namespace });
      if (Array.isArray(out)) return out;
      return arr;
    } catch (_) {
      return arr;
    }
  }

  function maybeCaptureStack(levelName) {
    var cfg = state.config.captureStack;
    if (!cfg) return '';
    var need = cfg === 'always' || cfg === true || (cfg === 'error' && (levelName === 'error' || levelName === 'warn'));
    if (!need) return '';
    try { throw new Error(); } catch (e) { return e && e.stack ? String(e.stack) : ''; }
  }

  function stringifyForPreview(value) {
    var type = typeof value;
    if (value === null) return 'null';
    if (type === 'undefined') return 'undefined';
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean' || type === 'bigint') return String(value);
    if (type === 'function') return '[function]';
    if (type === 'symbol') return '[symbol]';
    try {
      return JSON.stringify(value);
    } catch (_) {
      return '[object]';
    }
  }

  function createWildcardRegex(token) {
    // Escape regex special chars except * which we convert to .*
    var escaped = token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$');
  }

  function clone(obj) {
    var out = {};
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  function formatTime(d) {
    var h = pad2(d.getHours());
    var m = pad2(d.getMinutes());
    var s = pad2(d.getSeconds());
    var ms = pad3(d.getMilliseconds());
    return h + ':' + m + ':' + s + '.' + ms;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad3(n) {
    if (n < 10) return '00' + n;
    if (n < 100) return '0' + n;
    return '' + n;
  }

  function applyOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') return;
    if (typeof overrides.level === 'string' && LEVELS.hasOwnProperty(overrides.level)) {
      state.config.level = overrides.level;
      state.levelWeight = LEVELS[overrides.level];
    }
    if (typeof overrides.namespaces === 'string') {
      enableNamespaces(overrides.namespaces);
    }
    if (typeof overrides.enableColors === 'boolean') {
      state.config.enableColors = overrides.enableColors;
    }
    if (typeof overrides.showTime === 'boolean') {
      state.config.showTime = overrides.showTime;
    }
    if (typeof overrides.showNamespace === 'boolean') {
      state.config.showNamespace = overrides.showNamespace;
    }
    if (typeof overrides.showIcons === 'boolean') {
      state.config.showIcons = overrides.showIcons;
    }
    if (typeof overrides.bufferSize === 'number' && overrides.bufferSize > 0) {
      state.config.bufferSize = overrides.bufferSize | 0;
    }
    if (typeof overrides.overlay === 'boolean') {
      state.config.overlay = overrides.overlay;
      if (isBrowser && overrides.overlay) ensureOverlay();
    }
    if (typeof overrides.overlayLimit === 'number' && overrides.overlayLimit > 0) {
      state.config.overlayLimit = overrides.overlayLimit | 0;
    }
    if (typeof overrides.autoInstall === 'boolean') {
      state.config.autoInstall = overrides.autoInstall;
    }
    if (typeof overrides.captureStack === 'string' || typeof overrides.captureStack === 'boolean') {
      state.config.captureStack = overrides.captureStack;
    }
  }

  function readEnvironmentOverrides() {
    var o = {};

    // Allow disabling auto-install via a global flag set before this script executes
    if (globalScope && globalScope.__BETTER_CONSOLE_AUTO__ === false) {
      o.autoInstall = false;
    }

    if (isBrowser) {
      try {
        var params = new URLSearchParams(window.location.search || '');
        var qAuto = params.get('bc');
        var qLevel = params.get('bcLevel') || params.get('betterConsoleLevel');
        var qNs = params.get('bcNs') || params.get('bcNamespaces');
        var qColors = params.get('bcColors');
        var qIcons = params.get('bcIcons');
        var qShowTime = params.get('bcTime');
        var qShowNs = params.get('bcNsShow');
        var qOverlay = params.get('bcOverlay');
        var qOverlayLimit = params.get('bcOverlayLimit');
        var qBuf = params.get('bcBuffer');

        if (qAuto && qAuto.toLowerCase() === 'off') o.autoInstall = false;
        if (qLevel) o.level = qLevel.toLowerCase();
        if (qNs) o.namespaces = qNs;
        if (qColors != null) o.enableColors = qColors !== '0' && qColors.toLowerCase() !== 'false';
        if (qIcons != null) o.showIcons = qIcons !== '0' && qIcons.toLowerCase() !== 'false';
        if (qShowTime != null) o.showTime = qShowTime !== '0' && qShowTime.toLowerCase() !== 'false';
        if (qShowNs != null) o.showNamespace = qShowNs !== '0' && qShowNs.toLowerCase() !== 'false';
        if (qOverlay != null) o.overlay = qOverlay !== '0' && qOverlay.toLowerCase() !== 'false';
        if (qOverlayLimit && !isNaN(+qOverlayLimit)) o.overlayLimit = Math.max(1, parseInt(qOverlayLimit, 10));
        if (qBuf && !isNaN(+qBuf)) o.bufferSize = Math.max(1, parseInt(qBuf, 10));

        if (typeof window.localStorage !== 'undefined') {
          var lsLevel = window.localStorage.getItem('betterConsole.level');
          var lsNs = window.localStorage.getItem('betterConsole.namespaces');
          var lsColors = window.localStorage.getItem('betterConsole.colors');
          var lsIcons = window.localStorage.getItem('betterConsole.icons');
          var lsShowTime = window.localStorage.getItem('betterConsole.showTime');
          var lsShowNs = window.localStorage.getItem('betterConsole.showNamespace');
          var lsOverlay = window.localStorage.getItem('betterConsole.overlay');
          var lsOverlayLimit = window.localStorage.getItem('betterConsole.overlayLimit');
          var lsBuffer = window.localStorage.getItem('betterConsole.bufferSize');
          var lsAuto = window.localStorage.getItem('betterConsole.auto');

          if (!o.level && lsLevel) o.level = lsLevel.toLowerCase();
          if (!o.namespaces && lsNs) o.namespaces = lsNs;
          if (o.enableColors == null && lsColors != null) o.enableColors = lsColors !== '0' && lsColors !== 'false';
          if (o.showIcons == null && lsIcons != null) o.showIcons = lsIcons !== '0' && lsIcons !== 'false';
          if (o.showTime == null && lsShowTime != null) o.showTime = lsShowTime !== '0' && lsShowTime !== 'false';
          if (o.showNamespace == null && lsShowNs != null) o.showNamespace = lsShowNs !== '0' && lsShowNs !== 'false';
          if (!o.bufferSize && lsBuffer && !isNaN(+lsBuffer)) o.bufferSize = Math.max(1, parseInt(lsBuffer, 10));
          if (o.autoInstall == null && lsAuto != null) o.autoInstall = lsAuto !== '0' && lsAuto !== 'false';
          if (o.overlay == null && lsOverlay != null) o.overlay = lsOverlay !== '0' && lsOverlay !== 'false';
          if (!o.overlayLimit && lsOverlayLimit && !isNaN(+lsOverlayLimit)) o.overlayLimit = Math.max(1, parseInt(lsOverlayLimit, 10));
        }
      } catch (_) { /* ignore */ }
    } else {
      // Node: use process.env if available
      try {
        var env = (typeof process !== 'undefined' && process.env) ? process.env : {};
        if (env.BC === 'off') o.autoInstall = false;
        if (env.BC_LEVEL) o.level = String(env.BC_LEVEL).toLowerCase();
        if (env.BC_NS) o.namespaces = String(env.BC_NS);
        if (env.BC_COLORS != null) o.enableColors = env.BC_COLORS !== '0' && String(env.BC_COLORS).toLowerCase() !== 'false';
        if (env.BC_BUFFER && !isNaN(+env.BC_BUFFER)) o.bufferSize = Math.max(1, parseInt(env.BC_BUFFER, 10));
      } catch (_) { /* ignore */ }
    }

    return o;
  }

  // ---------- Overlay viewer ----------
  var overlayState = { el: null, body: null, visible: false, count: 0 };

  function ensureOverlay() {
    if (!isBrowser) return;
    if (overlayState.el) return;
    var el = document.createElement('div');
    el.id = 'better-console-overlay';
    el.style.position = 'fixed';
    el.style.right = '12px';
    el.style.bottom = '12px';
    el.style.width = '520px';
    el.style.maxHeight = '50vh';
    el.style.background = 'rgba(6,8,16,0.92)';
    el.style.border = '1px solid #1f2937';
    el.style.borderRadius = '10px';
    el.style.boxShadow = '0 10px 30px rgba(0,0,0,0.35)';
    el.style.backdropFilter = 'blur(6px)';
    el.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    el.style.color = '#e5e7eb';
    el.style.display = 'none';
    el.style.zIndex = '2147483647';
    el.innerHTML = '' +
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #1f2937;background:#0b1020;border-radius:10px 10px 0 0">' +
      '  <strong style="font-size:12px;">Better Console</strong>' +
      '  <span id="bc-ov-count" style="margin-left:auto;color:#9ca3af"></span>' +
      '  <button id="bc-ov-clear" style="background:#16223d;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px;padding:4px 8px;cursor:pointer">Clear</button>' +
      '  <button id="bc-ov-close" style="background:#1b2d58;color:#e5e7eb;border:1px solid #28407a;border-radius:6px;padding:4px 8px;cursor:pointer">×</button>' +
      '</div>' +
      '<div id="bc-ov-body" style="padding:8px 10px;overflow:auto;max-height:calc(50vh - 42px);"></div>';
    document.body.appendChild(el);
    overlayState.el = el;
    overlayState.body = el.querySelector('#bc-ov-body');
    el.querySelector('#bc-ov-close').onclick = hideOverlay;
    el.querySelector('#bc-ov-clear').onclick = function () { overlayState.body.innerHTML=''; overlayState.count=0; updateOverlayCount(); };
  }

  function overlayAppend(entry) {
    if (!overlayState.el) return;
    var div = document.createElement('div');
    var color = entry.level === 'error' ? '#ef4444' : entry.level === 'warn' ? '#f59e0b' : '#93c5fd';
    var t = new Date(entry.time).toLocaleTimeString();
    div.style.padding = '4px 0';
    div.innerHTML = '<span style="color:#9ca3af">[' + t + ']</span> ' +
      '<span style="color:' + color + ';font-weight:600">[' + entry.level.toUpperCase() + ']</span> ' +
      (entry.namespace ? '<span style="color:#6b7280">[' + entry.namespace + ']</span> ' : '') +
      '<span>' + escapeHtml(entry.preview) + '</span>';
    overlayState.body.appendChild(div);
    overlayState.count++;
    updateOverlayCount();
    // enforce limit
    var limit = state.config.overlayLimit || 500;
    while (overlayState.body.childNodes.length > limit) overlayState.body.removeChild(overlayState.body.firstChild);
    if (!overlayState.visible) showOverlay();
    overlayState.body.scrollTop = overlayState.body.scrollHeight;
  }

  function updateOverlayCount() {
    var el = overlayState.el && overlayState.el.querySelector('#bc-ov-count');
    if (el) el.textContent = String(overlayState.count);
  }

  function showOverlay() { if (overlayState.el) { overlayState.el.style.display = 'block'; overlayState.visible = true; } }
  function hideOverlay() { if (overlayState.el) { overlayState.el.style.display = 'none'; overlayState.visible = false; } }
  function toggleOverlay() { if (!overlayState.el) ensureOverlay(); if (overlayState.visible) hideOverlay(); else showOverlay(); }

  function bindOverlayHotkey() {
    if (!isBrowser) return;
    try {
      window.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
          toggleOverlay();
          try { e.preventDefault(); } catch (_) {}
        }
      });
    } catch (_) { /* ignore */ }
  }

  function escapeHtml(s) {
    try { return String(s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt','"':'&quot;','\'':'&#39;'})[c]; }); } catch (_) { return String(s); }
  }

  // ---------- Cross-frame injection ----------
  function installInto(targetWindow) {
    try {
      if (!targetWindow || !targetWindow.console) targetWindow.console = {};
      var prevGlobal = globalScope;
      var prevIsBrowser = isBrowser;
      try {
        globalScope = targetWindow;
        install();
      } finally {
        globalScope = prevGlobal;
        isBrowser = prevIsBrowser;
      }
      return true;
    } catch (_) { return false; }
  }

  function injectAllFrames() {
    if (!isBrowser) return 0;
    var injected = 0;
    try {
      var frames = window.frames;
      for (var i = 0; i < frames.length; i++) {
        try { if (installInto(frames[i])) injected++; } catch (_) {}
      }
    } catch (_) {}
    return injected;
  }
  var globalErrorHandlers = { installed: false, onError: null, onRejection: null };

  function captureGlobalErrors(options) {
    if (!isBrowser || globalErrorHandlers.installed) return;
    var opts = options || {};
    var logger = createLogger('runtime');
    globalErrorHandlers.onError = function (event) {
      try {
        // Resource load errors (script/img/css) do not populate event.error
        var target = event.target || event.srcElement;
        if (target && target.tagName) {
          var tag = String(target.tagName).toLowerCase();
          if (tag === 'script' || tag === 'link' || tag === 'img' || tag === 'iframe') {
            var attr = tag === 'link' ? 'href' : 'src';
            var ref = target.getAttribute && target.getAttribute(attr);
            logger.error('Resource load error', { tag: tag, url: ref || '', baseURI: target.baseURI || '' });
            return;
          }
        }
        logger.error('Unhandled error', event.error || event.message || event);
      } catch (_) {}
    };
    // Capture phase catches resource load errors
    window.addEventListener('error', globalErrorHandlers.onError, true);
    if (opts.rejections !== false) {
      globalErrorHandlers.onRejection = function (event) {
        try { logger.error('Unhandled rejection', event.reason); } catch (_) {}
      };
      window.addEventListener('unhandledrejection', globalErrorHandlers.onRejection);
    }
    try {
      window.addEventListener('securitypolicyviolation', function (e) {
        try { logger.error('CSP violation', { blockedURI: e.blockedURI, violatedDirective: e.violatedDirective, sourceFile: e.sourceFile, line: e.lineNumber }); } catch (_) {}
      });
    } catch (_) {}
    globalErrorHandlers.installed = true;
  }

  function releaseGlobalErrors() {
    if (!isBrowser || !globalErrorHandlers.installed) return;
    if (globalErrorHandlers.onError) window.removeEventListener('error', globalErrorHandlers.onError, true);
    if (globalErrorHandlers.onRejection) window.removeEventListener('unhandledrejection', globalErrorHandlers.onRejection);
    globalErrorHandlers.installed = false;
  }

  function addTransport(fn) {
    if (typeof fn !== 'function') return;
    state.transports.push(fn);
  }

  function removeTransport(fn) {
    var i = state.transports.indexOf(fn);
    if (i >= 0) state.transports.splice(i, 1);
  }

  function notifyTransports(entry) {
    if (!state.transports.length) return;
    for (var i = 0; i < state.transports.length; i++) {
      try { state.transports[i](entry); } catch (_) { /* ignore transport errors */ }
    }
  }

  function createHttpTransport(opts) {
    var options = opts || {};
    var url = options.url || '';
    var headers = options.headers || { 'content-type': 'application/json' };
    var batch = options.batch === true;
    var intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : 2000;
    var useBeacon = options.useBeacon !== false;
    var queue = [];
    var timer = null;

    function flush() {
      if (!queue.length) return;
      var payload = batch ? queue.splice(0, queue.length) : [queue.shift()];
      if (!url) return;
      var dataStr = '';
      try { dataStr = JSON.stringify(payload); } catch (_) { return; }
      try {
        if (isBrowser && useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          var blob = new Blob([dataStr], { type: 'application/json' });
          navigator.sendBeacon(url, blob);
          return;
        }
        if (typeof fetch === 'function') {
          fetch(url, { method: 'POST', headers: headers, body: dataStr }).catch(function () {});
        }
      } catch (_) { /* ignore */ }
    }

    function onVis() { try { if (document.visibilityState === 'hidden') flush(); } catch (_) {} }
    function dispose() {
      try { if (timer) clearInterval(timer); } catch (_) {}
      timer = null;
      if (isBrowser) {
        try { window.removeEventListener('pagehide', flush); } catch (_) {}
        try { window.removeEventListener('beforeunload', flush); } catch (_) {}
        try { window.removeEventListener('visibilitychange', onVis); } catch (_) {}
      }
    }
    if (isBrowser) {
      try { window.addEventListener('pagehide', flush); } catch (_) {}
      try { window.addEventListener('beforeunload', flush); } catch (_) {}
      try { window.addEventListener('visibilitychange', onVis); } catch (_) {}
    }

    var transport = function (entry) {
      if (!url) return;
      queue.push(entry);
      if (batch) {
        if (!timer) timer = setInterval(flush, intervalMs);
      } else {
        flush();
      }
    };
    transport.flush = flush;
    transport.dispose = dispose;
    return transport;
  }

  function createWindowTransport(opts) {
    var options = opts || {};
    var targetWindow = options.targetWindow || (isBrowser ? window.parent : null);
    var targetOrigin = options.targetOrigin || '*';
    return function (entry) {
      try {
        if (targetWindow && typeof targetWindow.postMessage === 'function') {
          targetWindow.postMessage({ __betterConsole: true, entry: entry }, targetOrigin);
        }
      } catch (_) { /* ignore */ }
    };
  }

  function startWindowListener() {
    if (!isBrowser || state.messageListenerInstalled) return;
    var origins = state.config.windowListenerOrigins || ['*'];
    function isAllowed(origin) {
      try {
        if (!origins || origins.length === 0) return true;
        if (origins.indexOf('*') !== -1) return true;
        return origins.indexOf(origin) !== -1;
      } catch (_) { return true; }
    }
    state.messageListener = function (ev) {
      try {
        if (!ev || !ev.data || ev.data.__betterConsole !== true) return;
        if (!isAllowed(ev.origin)) return;
        var entry = ev.data.entry || {};
        var args = Array.isArray(entry.args) ? entry.args : (entry.preview ? [entry.preview] : []);
        state.handlingRemote = true;
        try {
          emit(entry.level || 'log', entry.namespace || 'remote', args, null);
        } finally {
          state.handlingRemote = false;
        }
      } catch (_) { /* ignore */ }
    };
    try { window.addEventListener('message', state.messageListener); } catch (_) {}
    state.messageListenerInstalled = true;
  }

  function stopWindowListener() {
    if (!isBrowser || !state.messageListenerInstalled) return;
    try { window.removeEventListener('message', state.messageListener); } catch (_) {}
    state.messageListenerInstalled = false;
    state.messageListener = null;
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  // Stubs for optional advanced APIs to avoid ReferenceErrors
  function hookNetwork() { /* no-op */ }
  function hookWorker() { /* no-op */ }
  function reportError(err, context) {
    try { createLogger('runtime').error('Report', err, context || {}); } catch (_) {}
  }
  function captureNodeErrors() { /* no-op in browser */ }

  // ---------- Guard & window.open patch ----------
  function ensureConsoleWrapped() {
    if (!globalScope || !globalScope.console) return;
    var keys = ['debug','log','info','warn','error','trace','group','groupCollapsed'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var cur = globalScope.console[k];
      if (!cur || cur.__bc !== true) {
        try { globalScope.console[k] = state.wrappers[k] || createConsoleWrapper(k); } catch (_) {}
      }
    }
  }

  function startGuard() {
    stopGuard();
    try { state.guardTimer = setInterval(ensureConsoleWrapped, state.config.guardIntervalMs || 2000); } catch (_) {}
  }

  function stopGuard() {
    try { if (state.guardTimer) clearInterval(state.guardTimer); } catch (_) {}
    state.guardTimer = null;
  }

  function patchWindowOpen() {
    if (!isBrowser || state.openPatched) return;
    try {
      state.originalOpen = window.open;
      window.open = function () {
        var w = null;
        try { w = state.originalOpen.apply(window, arguments); } catch (e) { return w; }
        try { if (w && typeof w === 'object') installInto(w); } catch (_) {}
        return w;
      };
      state.openPatched = true;
    } catch (_) {}
  }

  function unpatchWindowOpen() {
    if (!isBrowser || !state.openPatched) return;
    try { if (state.originalOpen) window.open = state.originalOpen; } catch (_) {}
    state.openPatched = false;
  }

  function setNamespaceLevels(map) {
    state.nsLevelRules = compilePatternMap(map, function (lvl) { return LEVELS[lvl] || LEVELS.debug; });
  }

  function setSampling(map) {
    state.sampleRules = compilePatternMap(map, function (rate) {
      var n = Number(rate);
      return n >= 0 && n <= 1 ? n : 1;
    });
  }

  function setRedactor(fn) {
    state.redactorFn = (typeof fn === 'function') ? fn : null;
  }

  function getEffectiveLevelWeight(namespace) {
    var ns = typeof namespace === 'string' ? namespace : 'global';
    for (var i = 0; i < state.nsLevelRules.length; i++) {
      var rule = state.nsLevelRules[i];
      if (rule.re.test(ns)) return rule.value;
    }
    return state.levelWeight;
  }

  function shouldPassSampling(namespace) {
    var ns = typeof namespace === 'string' ? namespace : 'global';
    for (var i = 0; i < state.sampleRules.length; i++) {
      var rule = state.sampleRules[i];
      if (rule.re.test(ns)) return Math.random() < rule.value;
    }
    return true;
  }

  function compilePatternMap(map, transform) {
    var out = [];
    if (!map || typeof map !== 'object') return out;
    for (var key in map) if (Object.prototype.hasOwnProperty.call(map, key)) {
      var val = transform(map[key]);
      out.push({ re: createWildcardRegex(String(key)), value: val });
    }
    return out;
  }

  function exportBuffer() {
    try { return JSON.stringify(state.buffer.slice(), null, 2); } catch (_) { return '[]'; }
  }

  function importBuffer(jsonOrArray, options) {
    var append = options && options.append !== false;
    var arr;
    try { arr = Array.isArray(jsonOrArray) ? jsonOrArray : JSON.parse(String(jsonOrArray)); } catch (_) { return false; }
    if (!Array.isArray(arr)) return false;
    var trimmed = arr.map(function (e) {
      return { time: String(e.time || new Date().toISOString()), level: String(e.level || 'log'), namespace: String(e.namespace || 'global'), preview: String(e.preview || '') };
    });
    if (!append) state.buffer = [];
    Array.prototype.push.apply(state.buffer, trimmed);
    var overflow = state.buffer.length - state.config.bufferSize;
    if (overflow > 0) state.buffer.splice(0, overflow);
    return true;
  }

  function summarizeTable(subject) {
    try {
      if (Array.isArray(subject)) return 'rows ' + subject.length;
      if (subject && typeof subject === 'object') return 'object keys ' + Object.keys(subject).length;
      return typeof subject;
    } catch (_) { return 'table'; }
  }

  // --- Optional/stubbed APIs to avoid ReferenceErrors when exported ---
  function startWindowListener() { /* no-op */ }
  function stopWindowListener() { /* no-op */ }
  function hookNetwork() { /* no-op */ }
  function hookWorker() { /* no-op */ }
  function reportError(err, context) {
    try { createLogger('runtime').error('Reported error', err, context || {}); } catch (_) {}
  }
  function captureNodeErrors() { /* no-op in browser build */ }

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));



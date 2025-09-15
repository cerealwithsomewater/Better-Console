## Better Console

Small, dependency‑free JS enhancer for the global `console` in browsers and Node.

- Timestamps and level labels
- Colors (CSS in browser, ANSI in Node)
- Namespaced loggers with include/exclude patterns
- Runtime level control
- In‑memory ring buffer
- Install/restore wrappers

### Quick start (browser)

1) Drop the script into your app:

```html
<script src="./better-console.js"></script>
```

It auto‑installs with sensible defaults. The global `BetterConsole` object is available for control.

```js
BetterConsole.setLevel('info');
const log = BetterConsole.createLogger('app:auth');
log.info('Signed in', { userId: 123 });
```

### Quick start (Node)

```js
require('./better-console'); // auto‑installs

const log = BetterConsole.createLogger('worker:queue');
log.warn('Backlog high', { size: 2048 });
```

### API

- `BetterConsole.install(config?)` – Wrap global `console` methods. Called automatically unless disabled.
- `BetterConsole.restore()` – Restore original `console` methods.
- `BetterConsole.setLevel(level)` – One of `trace|debug|log|info|warn|error`.
- `BetterConsole.getLevel()` – Current level.
- `BetterConsole.enableNamespaces(pattern)` – Comma/space separated patterns with `*` wildcards. Prefix with `-` to exclude. Examples: `"*"`, `"app:*"`, `"app:*, -app:verbose, db"`.
- `BetterConsole.isNamespaceEnabled(ns)` – Check if a namespace would be logged.
- `BetterConsole.createLogger(namespace, { color? })` – Returns `{ trace, debug, log, info, warn, error }` bound to the namespace.
- `BetterConsole.getBuffer()` – Array of recent entries `{ time, level, namespace, preview }`.
- `BetterConsole.clearBuffer()` – Clear the ring buffer.
- `BetterConsole.getConfig()` – Current effective config snapshot.

### Configuration & overrides

Defaults:

```js
{
  level: 'debug',
  namespaces: '*',
  enableColors: true,
  bufferSize: 500,
  autoInstall: true
}
```

Browser query string (takes precedence):

- `?bc=off` – disable auto‑install
- `?bcLevel=warn` – set minimum level
- `?bcNs=app:*, -app:verbose` – namespace filters
- `?bcColors=0` – disable colors
- `?bcBuffer=1000` – ring buffer size

Browser `localStorage` (fallbacks):

- `betterConsole.level = info`
- `betterConsole.namespaces = app:*`
- `betterConsole.colors = 0|1`
- `betterConsole.bufferSize = 750`
- `betterConsole.auto = 0|1`

Node environment variables:

- `BC=off`
- `BC_LEVEL=info`
- `BC_NS=app:*, -db:verbose`
- `BC_COLORS=0|1`
- `BC_BUFFER=1000`

### Tips

- Wrap subsystems with `createLogger('app:feature')` to control noise using `enableNamespaces`.
- Use `BetterConsole.restore()` temporarily if a dependency expects raw console output.
- Prefers CSS styles in browser and ANSI in Node; disable with `?bcColors=0`.

### License

MIT



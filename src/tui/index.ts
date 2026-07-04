// TUI entry (T8). `render` with exitOnCtrlC:false — the app handles Ctrl+C itself (graceful abort).
// Config (role pins / budget from .aiki/config.json, T9) is loaded by the CLI entry and passed in here.

import React from 'react';
import { render } from 'ink';
import { App, type AppProps } from './app.js';

export function startTui(opts: AppProps = {}): void {
  render(React.createElement(App, opts), { exitOnCtrlC: false });
}

// TUI entry (T8). `render` with exitOnCtrlC:false — the app handles Ctrl+C itself (graceful abort).

import React from 'react';
import { render } from 'ink';
import { App } from './app.js';

export function startTui(): void {
  render(React.createElement(App), { exitOnCtrlC: false });
}

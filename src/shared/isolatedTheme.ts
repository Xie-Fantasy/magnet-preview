// Shared presentation for Shadow DOM surfaces; never inherits host-page colors.
export const isolatedThemeCss = `
  :host {
    --mp-surface: #fff !important;
    --mp-subtle: #f5f7f5 !important;
    --mp-ink: #202824 !important;
    --mp-muted: #626c65 !important;
    --mp-line: #e3e8e4 !important;
    --mp-accent: #28794e !important;
    --mp-contrast: #fff !important;
  }
  :host([data-theme="dark"]) {
    --mp-surface: #1d211f !important;
    --mp-subtle: #232825 !important;
    --mp-ink: #edf1ee !important;
    --mp-muted: #a7b0aa !important;
    --mp-line: #303833 !important;
    --mp-accent: #83c99a !important;
    --mp-contrast: #15251b !important;
  }
`;

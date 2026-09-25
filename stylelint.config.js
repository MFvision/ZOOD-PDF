export default {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-use-logical'],
  ignoreFiles: ['**/dist/**', '**/node_modules/**', '**/target/**', 'apps/ios/**'],
  rules: {
    // RTL-first: physical left/right properties are forbidden; use logical ones.
    'csstools/use-logical': ['always', { except: ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'top', 'bottom', 'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom', 'border-top', 'border-bottom'] }],
    'selector-class-pattern': null,
    'custom-property-pattern': null,
    'keyframes-name-pattern': null,
    'no-descending-specificity': null,
    'declaration-block-no-redundant-longhand-properties': null,
    'property-no-vendor-prefix': null,
    'value-keyword-case': null,
    'color-function-notation': null,
    'alpha-value-notation': null,
    'media-feature-range-notation': null,
    'import-notation': null,
  },
};

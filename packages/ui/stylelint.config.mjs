/** RTL-first CSS: only logical properties and values are allowed. */
export default {
  extends: ['stylelint-config-standard'],
  plugins: ['stylelint-use-logical'],
  rules: {
    'csstools/use-logical': ['always', { severity: 'error' }],
    'property-disallowed-list': [
      ['float', 'clear', '/^(margin|padding|border)-(left|right)/', 'left', 'right'],
      { message: 'Use logical properties (inline-start / inline-end) instead of physical ones.' },
    ],
    'declaration-property-value-disallowed-list': {
      'text-align': ['left', 'right'],
      float: ['left', 'right'],
    },
    'selector-class-pattern': '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
    'custom-property-pattern': '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
    'declaration-block-no-redundant-longhand-properties': null,
    'no-descending-specificity': null,
  },
};

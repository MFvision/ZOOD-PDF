/**
 * EmbedPDF's own English interface strings: the reference for the key tree the
 * Arabic locale must cover (`./ar.ts`), and nothing more. At runtime EmbedPDF
 * keeps using its built-in English; Warraq only adds Arabic beside it
 * (`../embedLanguage.ts`), so this copy is read by the type checker and the
 * tests, never by the viewer.
 *
 * Copied verbatim from @embedpdf/snippet 2.15.1, where it is the first entry
 * of the i18n plugin's default `locales` in dist/embedpdf-cl9qiF45.js. The
 * package exports none of its locales, so it cannot be imported. On an
 * EmbedPDF upgrade, copy it again: the e2e spec `embed-arabic.spec.ts` fails
 * when the running English and the Arabic have different keys.
 *
 * MIT License
 *
 * Copyright (c) 2025 CloudPDF
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const englishTranslations = {
  search: {
    placeholder: 'Search',
    caseSensitive: 'Case sensitive',
    wholeWord: 'Whole word',
    resultsFound: '{count} results found',
    page: 'Page {page}',
  },
  zoom: {
    in: 'Zoom In',
    out: 'Zoom Out',
    fitWidth: 'Fit to Width',
    fitPage: 'Fit to Page',
    marquee: 'Marquee Zoom',
    menu: 'Zoom Menu',
    level: 'Zoom Level ({level}%)',
    dragTip: 'Drag to select area to zoom',
  },
  pan: {
    toggle: 'Toggle Pan Mode',
  },
  pointer: {
    toggle: 'Toggle Pointer Mode',
  },
  capture: {
    screenshot: 'Screenshot',
    dragTip: 'Drag to select area to capture',
    title: 'Screenshot Preview',
    download: 'Download',
    cancel: 'Cancel',
  },
  document: {
    menu: 'Document Menu',
    open: 'Open',
    close: 'Close',
    print: 'Print',
    protect: 'Security',
    export: 'Export',
    fullscreen: 'Fullscreen',
    loading: 'Loading document...',
  },
  emptyState: {
    title: 'No Documents Open',
    description: 'Open a PDF document to get started.',
    descriptionMulti: 'You can view multiple documents using tabs.',
    openButton: 'Open Document',
    supportedFormats: 'Supported format: PDF',
  },
  passwordPrompt: {
    title: 'Password Required',
    required: 'This document is password protected. Please enter the password to open it.',
    incorrect: 'The password you entered was incorrect. Please try again.',
    incorrectWarning: 'Incorrect password. Please check and try again.',
    label: 'Password',
    placeholder: 'Enter document password',
    open: 'Open',
    opening: 'Opening...',
    cancel: 'Cancel',
    close: 'Close',
  },
  documentError: {
    title: 'Error loading document',
    unknown: 'An unknown error occurred',
    errorCode: 'Error Code: {code}',
    close: 'Close Document',
  },
  panel: {
    sidebar: 'Sidebar',
    search: 'Search',
    comment: 'Comment',
    thumbnails: 'Thumbnails',
    outline: 'Outline',
    annotationStyle: 'Annotation Style',
    redaction: 'Redaction Sidebar',
  },
  menu: {
    viewControls: 'View Controls',
    zoomControls: 'Zoom Controls',
    moreOptions: 'More Options',
  },
  outline: {
    title: 'Outline',
    loading: 'Loading outline...',
    noOutline: 'No outline available',
    noBookmarks: "This document doesn't contain bookmarks",
  },
  page: {
    settings: 'Page Settings',
    single: 'Single Page',
    twoOdd: 'Two Page (Odd)',
    twoEven: 'Two Page (Even)',
    vertical: 'Vertical',
    horizontal: 'Horizontal',
    spreadMode: 'Spread Mode',
    scrollLayout: 'Scroll Layout',
    rotation: 'Page Rotation',
    next: 'Next Page',
    previous: 'Previous Page',
  },
  rotate: {
    clockwise: 'Rotate Clockwise',
    counterClockwise: 'Rotate Counter-Clockwise',
  },
  selection: {
    copy: 'Copy Selection',
  },
  mode: {
    view: 'View',
    annotate: 'Annotate',
    shapes: 'Shapes',
    form: 'Form',
    redact: 'Redact',
    insert: 'Insert',
  },
  form: {
    textfield: 'Text Field',
    checkbox: 'Checkbox',
    radio: 'Radio Button',
    select: 'Dropdown',
    listbox: 'List Box',
  },
  annotation: {
    text: 'Text',
    highlight: 'Highlight',
    strikeout: 'Strikethrough',
    underline: 'Underline',
    squiggly: 'Squiggly',
    rectangle: 'Rectangle',
    circle: 'Circle',
    line: 'Line',
    arrow: 'Arrow',
    polygon: 'Polygon',
    polyline: 'Polyline',
    ink: 'Ink',
    inkHighlighter: 'Ink Highlighter',
    stamp: 'Stamp',
    caret: 'Caret',
    insertText: 'Insert Text',
    replaceText: 'Replace Text',
    freeText: 'Free Text',
    square: 'Square',
    style: 'Annotation Style',
    styles: '{type} Styles',
    defaults: '{type} Defaults',
    color: 'Color',
    opacity: 'Opacity',
    blendMode: 'Blend mode',
    strokeWidth: 'Stroke width',
    strokeColor: 'Stroke color',
    borderStyle: 'Border style',
    fillColor: 'Fill color',
    fontSize: 'Font size',
    fontFamily: 'Font',
    textAlign: 'Text alignment',
    verticalAlign: 'Vertical alignment',
    lineEnding: 'Line ending',
    lineStart: 'Line start',
    lineEnd: 'Line end',
    font: 'Font',
    fontColor: 'Font color',
    backgroundColor: 'Background color',
    noStyles: 'There are no styles for this annotation.',
    noStylesStamp: 'There are no styles for stamps.',
    selectAnnotation: 'Select an annotation to see styles',
    deleteSelected: 'Delete selected annotation',
    deleteAllSelected: 'Delete Selected',
    multiSelect: '{count} annotations selected',
    group: 'Group',
    ungroup: 'Ungroup',
    moreTools: 'More Tools',
    addLink: 'Add Link',
    removeLink: 'Remove Link',
    gotoLink: 'Go to Link',
    comment: 'Comment',
    callout: 'Callout',
    redact: 'Redact',
    overlayText: 'Overlay Text',
    overlayTextPlaceholder: 'e.g., REDACTED',
    rotation: 'Rotation',
  },
  insert: {
    image: 'Image',
    rubberStamp: 'Rubber Stamp',
  },
  redaction: {
    redact: 'Redact',
    area: 'Redact Area',
    text: 'Redact Text',
    apply: 'Apply Redaction',
    applyAll: 'Apply All',
    clearAll: 'Clear All',
    deleteSelected: 'Delete selected redaction',
    commitSelected: 'Apply selected redaction',
    emptyState: 'No pending redactions',
    panel: {
      title: 'Redactions',
      itemCount: '{count} pending redaction',
      itemCountPlural: '{count} pending redactions',
      clearAll: 'Clear All',
      redactAll: 'Redact All',
    },
  },
  history: {
    undo: 'Undo',
    redo: 'Redo',
  },
  comments: {
    page: 'Page {page}',
    commentCount: '{count} comment',
    commentCountPlural: '{count} comments',
    addComment: 'Add comment...',
    addReply: 'Add reply...',
    showAllAnnotations: 'Show All Annotations',
    closeAllAnnotations: 'Close All Annotations',
    save: 'Save',
    cancel: 'Cancel',
    edit: 'Edit',
    delete: 'Delete',
    showMore: 'more',
    showLess: 'less',
    emptyState: 'Add annotations to be able to comment on them.',
  },
  blendMode: {
    normal: 'Normal',
    multiply: 'Multiply',
    screen: 'Screen',
    overlay: 'Overlay',
    darken: 'Darken',
    lighten: 'Lighten',
    colorDodge: 'Color Dodge',
    colorBurn: 'Color Burn',
    hardLight: 'Hard Light',
    softLight: 'Soft Light',
    difference: 'Difference',
    exclusion: 'Exclusion',
    hue: 'Hue',
    saturation: 'Saturation',
    color: 'Color',
    luminosity: 'Luminosity',
  },
  print: {
    title: 'Print Settings',
    loading: 'Preparing document...',
    pages: 'Pages to print',
    all: 'All pages',
    current: 'Current page ({currentPage})',
    specify: 'Specify pages',
    specifyEG: 'e.g., 1-3, 5, 8-10',
    total: 'Total pages in document: {totalPages}',
    annotation: 'Include annotations',
    printing: 'Printing...',
    print: 'Print',
    cancel: 'Cancel',
  },
  protect: {
    title: 'Protect Document',
    cancel: 'Cancel',
    apply: 'Apply Protection',
    applying: 'Applying...',
    applyFailed: 'Failed to apply protection. Please try again.',
    removeFailed: 'Failed to remove protection. Please try again.',
    passwordMismatch: 'Passwords do not match',
    noProtectionSelected: 'Select at least one protection option to apply.',
    bothPasswordsNote:
      'Users who open with the document password will have restricted permissions. Use the owner password to unlock full access.',
    openPassword: {
      title: 'Require password to open',
      description: 'Users must enter a password to view this document.',
      label: 'Document Password',
      placeholder: 'Enter password',
      confirm: 'Confirm Password',
      confirmPlaceholder: 'Confirm password',
    },
    ownerPassword: {
      label: 'Owner Password',
      placeholder: 'Enter owner password',
      confirm: 'Confirm Owner Password',
      confirmPlaceholder: 'Confirm owner password',
    },
    permissions: {
      title: 'Restrict permissions',
      description: 'Limit what users can do with this document.',
      allowedActions: 'Allowed actions',
      print: 'Print',
      printHighQuality: 'Print high quality',
      copy: 'Copy content',
      accessibility: 'Extract for accessibility',
      modify: 'Modify content',
      annotations: 'Add/modify annotations & comments',
      fillForms: 'Fill forms & sign',
      assemble: 'Assemble & extract pages',
    },
    encrypted: {
      title: 'Document is Protected',
      description:
        'This document is protected by the owner. Enter the owner password to modify security settings.',
      enterOwnerPassword: 'Enter Owner Password to Modify',
      unlockAndEdit: 'Unlock & Edit',
    },
    modifyProtection: {
      title: 'Modify Protection',
      description: 'Choose how you want to modify the document protection.',
      changeOption: 'Change Passwords or Permissions',
      changeDescription: 'Update the document password or permission settings.',
      removeOption: 'Remove All Protection',
      removeDescription: 'Remove password protection from this document.',
    },
    removeProtection: {
      title: 'Remove Protection',
      warning: 'Are you sure you want to remove protection?',
      description:
        'This will remove all password protection from the document. Anyone will be able to open and modify it.',
      confirm: 'Remove Protection',
    },
  },
  security: {
    protected: {
      title: 'This Document is Protected',
      description:
        'This file is protected and some features may be disabled. Go to Security in the document menu to view or unlock permissions.',
      viewPermissions: 'View permissions',
    },
    viewPermissions: {
      title: 'Document Permissions',
      description:
        'This file is restricted by the owner and requires a password to unlock certain actions.',
      restrictedActions: 'Restricted Actions',
    },
    unlock: {
      label: 'Enter Owner Password to Unlock File',
      placeholder: 'Enter owner password',
      button: 'Unlock file',
      invalidPassword: 'Invalid password. Please try again.',
      failed: 'Failed to unlock. Please try again.',
      success: 'Owner permissions unlocked! You now have full access.',
    },
  },
  common: {
    close: 'Close',
    back: 'Back',
    cancel: 'Cancel',
  },
  link: {
    title: 'Insert Link',
    url: 'URL',
    page: 'Page',
    enterUrl: 'Enter URL',
    enterPage: 'Enter Page Number',
    pageRange: 'Page 1 to {totalPages}',
    link: 'Link',
  },
  stamp: {
    title: 'Rubber Stamps',
    allStamps: 'All Stamps',
    export: 'Export Stamps',
    emptyState: 'No stamps found in the selected library.',
    createFromSelected: 'Create Stamp',
    createFromGroup: 'Create Stamp from Group',
    library: {
      custom: 'Custom Stamps',
    },
  },
  signature: {
    title: 'Signatures',
    createNew: 'Create New Signature',
    createNewWithInitials: 'Create Signature & Initials',
    placeSignature: 'Signature',
    placeInitials: 'Initials',
    remove: 'Remove signature',
    emptyState: 'No signatures yet. Create one to get started.',
    create: {
      title: 'Create Signature',
      draw: 'Draw',
      type: 'Type',
      upload: 'Upload',
      signatureLabel: 'Signature',
      initialsLabel: 'Initials',
      clear: 'Clear',
      typePlaceholder: 'e.g. John Smith',
      initialsPlaceholder: 'e.g. JS',
      uploadPlaceholder: 'Click or drag an image here',
      font: 'Font',
      color: 'Color',
      cancel: 'Cancel',
      save: 'Save',
    },
  },
};

/** The shape of EmbedPDF's translations: every key, each a string. */
export type EmbedTranslations = typeof englishTranslations;

import { mountApp } from '@zood/ui';

if (navigator.language?.toLowerCase().startsWith('ar')) document.title = 'زود PDF';

// MV3 extension pages cannot start workers from blob: URLs (script-src is limited to 'self'), so the
// viewer runs PDFium on the page thread here; the engine worker is a packaged file and still works.
mountApp(document.getElementById('root')!, { platform: 'extension', viewerWorker: false });

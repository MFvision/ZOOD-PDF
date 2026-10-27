import { describe, expect, it } from 'vitest';
import { besideFile, documentStem, exportFileName, pageImageName, pagesArchiveName, pdfFileName } from './saveFile';

describe('names of the files Warraq writes', () => {
  it('names an export after its document, whatever the case of ".pdf"', () => {
    expect(exportFileName('report.pdf', 'docx')).toBe('report.docx');
    expect(exportFileName('تقرير الربع الأول.PDF', 'txt')).toBe('تقرير الربع الأول.txt');
    expect(exportFileName('report.final.pdf', 'md')).toBe('report.final.md');
    expect(exportFileName('no-extension', 'html')).toBe('no-extension.html');
    expect(exportFileName('   ', 'docx')).toBe('document.docx');
  });

  it('names the zip of page images for the document and its pages', () => {
    expect(pagesArchiveName('report.pdf', 'pages')).toBe('report (pages).zip');
    expect(pagesArchiveName('تقرير.pdf', 'الصفحات')).toBe('تقرير (الصفحات).zip');
  });

  it('numbers page images so they sort in page order', () => {
    expect(pageImageName('report.pdf', 3, 9)).toBe('report-3.png');
    expect(pageImageName('report.pdf', 3, 12)).toBe('report-03.png');
    expect(pageImageName('تقرير.pdf', 7, 120)).toBe('تقرير-007.png');
  });

  it('keeps the PDF names it had', () => {
    expect(pdfFileName('report')).toBe('report.pdf');
    expect(documentStem('report.pdf')).toBe('report');
  });
});

describe('besideFile', () => {
  it('puts the name in the folder of the open file', () => {
    expect(besideFile('C:\\Users\\pCd\\Documents\\ملف.pdf', 'ملف.pdf')).toBe('C:\\Users\\pCd\\Documents\\ملف.pdf');
    expect(besideFile('/Users/m/Desktop/a.pdf', 'a.pdf')).toBe('/Users/m/Desktop/a.pdf');
    expect(besideFile(undefined, 'a.pdf')).toBe('a.pdf');
    expect(besideFile('a.pdf', 'b.pdf')).toBe('b.pdf');
  });
});

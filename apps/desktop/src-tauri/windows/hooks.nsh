; The Windows installer's own steps around Tauri's (bundle.windows.nsis.installerHooks
; in tauri.windows.conf.json).
;
; Tauri registers .pdf with the app (fileAssociations) but gives the file the
; app's own icon, `warraq-desktop.exe,0`, so a PDF looked like the program
; rather than a document (the owner's backlog, item 2). Here the file class
; gets the document icon instead (scripts/icon/make_pdf_document_icon.py), and
; the app joins .pdf's "Open with" list. Windows shows the icon on every PDF
; once محرر PDF is the default app for PDFs, which only the person can choose
; (Windows asks the first time, or Settings > Apps > Default apps).

!macro ZOOD_REMOVE_TO_PDF KIND
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\ZoodPDF.ToPdf"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\ZoodPDF.Document\DefaultIcon" "" "$INSTDIR\resources\windows\pdf-document.ico"
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "ZoodPDF.Document" ""
  ; Explorer caches icons: tell it the associations changed (FileAssociation.nsh).
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "ZoodPDF.Document"
  ; The quick tools' right-click entries the app wrote for this account
  ; (src/shell_menu.rs, verb_roots).
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\ZoodPDF.Quick"
  !insertmacro ZOOD_REMOVE_TO_PDF "image"
  !insertmacro ZOOD_REMOVE_TO_PDF ".docx"
  !insertmacro ZOOD_REMOVE_TO_PDF ".xlsx"
  !insertmacro ZOOD_REMOVE_TO_PDF ".pptx"
  !insertmacro ZOOD_REMOVE_TO_PDF ".txt"
  !insertmacro ZOOD_REMOVE_TO_PDF ".md"
  !insertmacro ZOOD_REMOVE_TO_PDF ".html"
  !insertmacro ZOOD_REMOVE_TO_PDF ".htm"
  !insertmacro ZOOD_REMOVE_TO_PDF ".csv"
  !insertmacro UPDATEFILEASSOC
!macroend

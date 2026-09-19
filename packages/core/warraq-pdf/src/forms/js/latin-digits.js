/* محرر PDF: Arabic-Indic (and Persian) digits typed into a number field become
   Western ones, and the Arabic decimal and thousands signs a dot and a comma,
   so the value stays a number every reader can calculate with. */
function Warraq_LatinDigits() {
  function latin(text) {
    return String(text)
      .replace(/[٠-٩۰-۹]/g, function (c) {
        var code = c.charCodeAt(0);
        return String.fromCharCode(48 + code - (code >= 0x06F0 ? 0x06F0 : 0x0660));
      })
      .replace(/٫/g, ".")
      .replace(/٬/g, ",");
  }
  if (event.willCommit) event.value = latin(event.value);
  else event.change = latin(event.change);
}

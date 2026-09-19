/* ورّاق: the formatted value in Arabic-Indic digits, with the Arabic decimal,
   thousands and percent signs. A separator is one only before a digit, so the
   dot of "ر.س" stays a dot. */
function Warraq_Digits() {
  var signs = { ".": "٫", ",": "٬", "%": "٪" };
  event.value = String(event.value).replace(/[0-9%]|[.,](?=[0-9])/g, function (c) {
    return signs[c] || String.fromCharCode(0x0660 + c.charCodeAt(0) - 48);
  });
}

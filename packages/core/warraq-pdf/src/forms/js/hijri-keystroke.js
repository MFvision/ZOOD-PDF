/* محرر PDF: accepts only a real Hijri date by the Umm al-Qura calendar, written
   in the order `pattern` gives (yyyy, mm, dd; a month may be named), when the
   value is committed. The table is the one in Warraq_HijriFormat. */
function Warraq_HijriKeystroke(pattern) {
  var table = "eaae94d2ac564aea6d56ad55d4aa9352ba5b53a6b5ea9d52d29a554ad56daea6e4ed1da2aaa95a2da5b9bb27646c95552ab4dbaba5b4da9d52aa592d26d8ed2daad5aa5a4b4979372b6975d69d52c9592b25b4db9d55d2da5d4aa9554daad3aabd2bc4b89a9552d5adb6a6d4dc9d92aa69562ae56d36ab55aaa94d49d95d2ba5b55aad55a9a92e26e55dada6d46a5b27a4d4ad56db5a754f49e92d26a563566b5baab92b2568ba9b55aada5b4da9b52a9a536276575af26d46a95552ad4bd9ba574b69b52a9552da5d4daad96b2e95e2ac9692eaad56ad65d4a";
  var names = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
  function length(y, m) {
    if (y >= 1356 && y <= 1500) return (parseInt(table.substr((y - 1356) * 3, 3), 16) >> (m - 1)) & 1 ? 30 : 29;
    if (m % 2 == 1) return 30;
    if (m < 12) return 29;
    return (11 * y + 14) % 30 < 11 ? 30 : 29;
  }
  function valid(text) {
    text = text.replace(/[٠-٩۰-۹]/g, function (c) {
      var code = c.charCodeAt(0);
      return String.fromCharCode(48 + code - (code >= 0x06F0 ? 0x06F0 : 0x0660));
    });
    var numbers = text.match(/[0-9]+/g) || [];
    var named = 0;
    for (var k = 0; k < 12; k++) if (text.indexOf(names[k]) >= 0) named = k + 1;
    var order = [];
    var y = pattern.indexOf("y"), m = pattern.indexOf("m"), d = pattern.indexOf("d");
    if (y >= 0) order.push([y, "y"]);
    if (m >= 0 && !named) order.push([m, "m"]);
    if (d >= 0) order.push([d, "d"]);
    order.sort(function (a, b) { return a[0] - b[0]; });
    if (numbers.length != order.length) return false;
    var parts = { y: 0, m: named, d: 1 };
    for (var i = 0; i < order.length; i++) parts[order[i][1]] = parseInt(numbers[i], 10);
    if (parts.y < 100) parts.y += 1400;
    return parts.m >= 1 && parts.m <= 12 && parts.d >= 1 && parts.d <= length(parts.y, parts.m);
  }
  if (!event.willCommit || String(event.value) == "") return;
  if (!valid(String(event.value))) {
    app.alert("هذا ليس تاريخًا هجريًا صحيحًا (" + pattern + ").\nThis is not a valid Hijri date (" + pattern + ").");
    event.rc = false;
  }
}

/* ورّاق: a Hijri date by the Umm al-Qura calendar, shown in `pattern`
   (yyyy, yy, mmmm, mm, m, dd, d; anything else as written), in Arabic-Indic
   digits when `arabic`. The months of 1356-1500 AH are the published table,
   one bit a month (30 days when set), three hex digits a year from 1356;
   outside it, the tabular Islamic calendar. */
function Warraq_HijriFormat(pattern, arabic) {
  var table = "eaae94d2ac564aea6d56ad55d4aa9352ba5b53a6b5ea9d52d29a554ad56daea6e4ed1da2aaa95a2da5b9bb27646c95552ab4dbaba5b4da9d52aa592d26d8ed2daad5aa5a4b4979372b6975d69d52c9592b25b4db9d55d2da5d4aa9554daad3aabd2bc4b89a9552d5adb6a6d4dc9d92aa69562ae56d36ab55aaa94d49d95d2ba5b55aad55a9a92e26e55dada6d46a5b27a4d4ad56db5a754f49e92d26a563566b5baab92b2568ba9b55aada5b4da9b52a9a536276575af26d46a95552ad4bd9ba574b69b52a9552da5d4daad96b2e95e2ac9692eaad56ad65d4a";
  var names = ["محرم", "صفر", "ربيع الأول", "ربيع الآخر", "جمادى الأولى", "جمادى الآخرة", "رجب", "شعبان", "رمضان", "شوال", "ذو القعدة", "ذو الحجة"];
  function length(y, m) {
    if (y >= 1356 && y <= 1500) return (parseInt(table.substr((y - 1356) * 3, 3), 16) >> (m - 1)) & 1 ? 30 : 29;
    if (m % 2 == 1) return 30;
    if (m < 12) return 29;
    return (11 * y + 14) % 30 < 11 ? 30 : 29;
  }
  function parse(text) {
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
    if (numbers.length != order.length) return null;
    var parts = { y: 0, m: named, d: 1 };
    for (var i = 0; i < order.length; i++) parts[order[i][1]] = parseInt(numbers[i], 10);
    if (parts.y < 100) parts.y += 1400;
    if (parts.m < 1 || parts.m > 12 || parts.d < 1 || parts.d > length(parts.y, parts.m)) return null;
    return parts;
  }
  function pad(n, width) {
    n = String(n);
    while (n.length < width) n = "0" + n;
    return n;
  }
  var value = String(event.value);
  if (value == "") return;
  var date = parse(value);
  if (!date) return;
  var out = "";
  for (var i = 0; i < pattern.length; ) {
    var c = pattern.charAt(i), run = 1;
    while (pattern.charAt(i + run) == c) run++;
    if (c == "y") out += run >= 3 ? pad(date.y, 4) : pad(date.y % 100, 2);
    else if (c == "m") out += run >= 3 ? names[date.m - 1] : run == 2 ? pad(date.m, 2) : String(date.m);
    else if (c == "d") out += run >= 2 ? pad(date.d, 2) : String(date.d);
    else out += pattern.substr(i, run);
    i += run;
  }
  if (arabic) out = out.replace(/[0-9]/g, function (c) { return String.fromCharCode(0x0660 + c.charCodeAt(0) - 48); });
  event.value = out;
}

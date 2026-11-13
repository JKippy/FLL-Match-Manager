// Draw a rankings QR onto a canvas. Uses the vendored generator in qrcode.js
// (QR Code Generator for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT).
// Error correction is M (medium). The white border is 4 modules, the quiet zone.
// Throws when the text is too long for a QR symbol; the page then shows nothing.
var NEXUS_QR_QUIET = 4;
var NEXUS_QR_CELL = 10;
function drawNexusQr(canvas, text) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var margin = NEXUS_QR_QUIET;
  var cell = NEXUS_QR_CELL;
  var size = (n + margin * 2) * cell;
  canvas.width = size;
  canvas.height = size;
  var g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  var r, c;
  for (r = 0; r < n; r++) {
    for (c = 0; c < n; c++) {
      if (qr.isDark(r, c)) g.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
    }
  }
  return n;
}

const { storagePrefixes } = require("../lib/common");
const { r2Get } = require("../lib/r2");

// Latest rolling canvas for the "asleep" backdrop. Cached at the edge for a minute.
// R2 only: live-sdxl, then the older live session; first hit wins.
module.exports = async (req, res) => {
  for (const prefix of storagePrefixes()) {
    const b = await r2Get(`${prefix}/canvas.png`);   // the pod writes canvas.png to R2 only
    if (b) {
      res.setHeader("content-type", "image/png");
      res.setHeader("cache-control", "public, s-maxage=60, max-age=60");
      return res.status(200).send(b);
    }
  }
  return res.status(404).end();
};

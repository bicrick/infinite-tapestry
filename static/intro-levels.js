// Worker for the load-in intro: luminance 4th/96th percentiles of a 32x8 band thumbnail.
// The pixel readback happens here so the main thread never waits on the GPU.
const c = new OffscreenCanvas(32, 8);
const g = c.getContext("2d", { willReadFrequently: true });
onmessage = (e) => {
  const bmp = e.data;
  g.clearRect(0, 0, 32, 8);
  g.drawImage(bmp, 0, 0, 32, 8);
  bmp.close();
  const d = g.getImageData(0, 0, 32, 8).data, L = new Float32Array(256);
  for (let i = 0; i < 256; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  L.sort();
  postMessage([L[10], L[245]]);
};

const fs = require("fs");
const localtunnel = require("localtunnel");

(async () => {
  const tunnel = await localtunnel({ port: 5173, local_host: "127.0.0.1" });
  fs.writeFileSync("tunnel-url.txt", tunnel.url, "utf8");
  console.log(`公网链接：${tunnel.url}`);
  tunnel.on("close", () => {
    console.log("公网隧道已关闭");
  });
})();

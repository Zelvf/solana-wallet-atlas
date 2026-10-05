import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

export class InvalidRpcError extends Error {}

export type CustomRpcTarget = { url: URL; ip: string };

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");

export async function resolveCustomRpc(input: unknown): Promise<CustomRpcTarget> {
  if (typeof input !== "string" || input.length > 2048) throw new InvalidRpcError("Enter a valid HTTPS RPC URL.");
  let url: URL;
  try { url = new URL(input); } catch { throw new InvalidRpcError("Enter a valid HTTPS RPC URL."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash) {
    throw new InvalidRpcError("Use an HTTPS RPC URL without embedded username, password, or fragment.");
  }
  if (url.hostname.includes(":") || !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !url.hostname.includes(".") || /\.(local|localhost|internal|test)\.?$/i.test(url.hostname)) {
    throw new InvalidRpcError("Use a public HTTPS RPC hostname or public IPv4 address.");
  }
  let addresses: { address: string }[];
  if (isIP(url.hostname) === 4) {
    addresses = [{ address: url.hostname }];
  } else {
    try {
      addresses = await lookup(url.hostname, { all: true, family: 4 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAI_AGAIN") {
        throw new InvalidRpcError("The custom RPC hostname could not be resolved.");
      }
      try { addresses = await lookup(url.hostname, { all: true, family: 4 }); }
      catch { throw new InvalidRpcError("The custom RPC hostname could not be resolved."); }
    }
  }
  if (!addresses.length || addresses.some((item) => isIP(item.address) !== 4 || blocked.check(item.address, "ipv4"))) {
    throw new InvalidRpcError("The custom RPC must resolve only to public IPv4 addresses.");
  }
  return { url, ip: addresses[0].address };
}

export async function postCustomRpc(target: CustomRpcTarget, body: string): Promise<{ status: number; contentType: string; retryAfter: string | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: target.ip, family: 4 }]);
        else callback(null, target.ip, 4);
      },
      timeout: 12000,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8_000_000) {
          outgoing.destroy(new Error("Custom RPC response is too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode || 502,
          contentType: response.headers["content-type"] || "unknown content type",
          retryAfter: response.headers["retry-after"],
          text: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("Custom RPC timed out.")));
    outgoing.on("error", (error) => {
      if (error.message === "Custom RPC timed out." || error.message === "Custom RPC response is too large.") reject(error);
      else reject(new Error(`Could not connect to the custom RPC. Check its URL and TLS certificate. (${(error as NodeJS.ErrnoException).code || "network error"})`));
    });
    outgoing.end(body);
  });
}

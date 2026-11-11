import { readKey } from "./auto-share.js";
import { ADDRESS_RE, createInvitation, encodeInvitation } from "./transaction.js";
import { addressFromPublicKey } from "./wallet.js";

async function main() {
  const file = process.env.ALBUS_KEY_FILE;
  const friend = process.env.FRIEND ?? "";
  if (!file || !ADDRESS_RE.test(friend)) {
    console.error("Setze ALBUS_KEY_FILE (deine Schluesseldatei) und FRIEND (Adresse des Freundes, albus1...).");
    process.exit(1);
  }
  const key = readKey(file);
  let networkId = process.env.NETWORK_ID;
  if (!networkId) {
    const base = process.env.ALBUS_API ?? "http://127.0.0.1:4000";
    networkId = ((await (await fetch(`${base}/info`)).json()) as { networkId: string }).networkId;
  }
  if (addressFromPublicKey(key.publicKey) === friend) throw new Error("Du kannst dich nicht selbst einladen.");
  console.error(`Deine Adresse: ${addressFromPublicKey(key.publicKey)}\nNetz: ${networkId}\nEinlader: ${friend}`);
  console.log(encodeInvitation(createInvitation(key.privateKey, key.publicKey, friend, networkId)));
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

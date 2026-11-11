import { generateKeyPair } from "./wallet.js";

console.log(JSON.stringify(generateKeyPair(), null, 2));

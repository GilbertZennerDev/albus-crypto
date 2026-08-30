import { useEffect, useState } from "react";
import { generateKeyPair, keyPairFromPrivateKey, type KeyPair } from "./wallet";

const STORAGE_KEY = "albus.wallet.privateKey";

export function useWallet() {
  const [wallet, setWallet] = useState<KeyPair | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setWallet(keyPairFromPrivateKey(stored));
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  function createWallet() {
    const kp = generateKeyPair();
    localStorage.setItem(STORAGE_KEY, kp.privateKey);
    setWallet(kp);
  }

  function importWallet(privateKeyHex: string) {
    const kp = keyPairFromPrivateKey(privateKeyHex.trim());
    localStorage.setItem(STORAGE_KEY, kp.privateKey);
    setWallet(kp);
  }

  function clearWallet() {
    localStorage.removeItem(STORAGE_KEY);
    setWallet(null);
  }

  return { wallet, createWallet, importWallet, clearWallet };
}

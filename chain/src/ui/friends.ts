import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../auto-share.js";
import { ADDRESS_RE } from "../transaction.js";

export interface Friend {
  name: string;
  address: string;
  percent: number;
}

export interface FriendsFile {
  friends: Friend[];
  inviter: string | null;
  shareEnabled: boolean;
}

export const MAX_FRIENDS = 50;
export const EMPTY: FriendsFile = { friends: [], inviter: null, shareEnabled: false };

export class FriendsError extends Error {}

export function validateFriends(input: unknown, ownAddress: string | null): FriendsFile {
  const x = input as Partial<FriendsFile> | null;
  if (!x || typeof x !== "object" || !Array.isArray(x.friends)) throw new FriendsError("Ungueltige Liste");
  if (x.friends.length > MAX_FRIENDS) throw new FriendsError(`Hoechstens ${MAX_FRIENDS} Freunde`);
  const seen = new Set<string>();
  let sum = 0;
  const friends = x.friends.map((f: unknown) => {
    const e = f as Partial<Friend> | null;
    if (!e || typeof e !== "object") throw new FriendsError("Ungueltiger Eintrag");
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (name.length < 1 || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) throw new FriendsError("Name: 1 bis 40 Zeichen, ohne < > und Steuerzeichen");
    if (typeof e.address !== "string" || !ADDRESS_RE.test(e.address)) throw new FriendsError(`Ungueltige Adresse bei ${name}`);
    if (e.address === ownAddress) throw new FriendsError(`${name}: das ist deine eigene Adresse`);
    if (seen.has(e.address)) throw new FriendsError(`Adresse kommt doppelt vor: ${name}`);
    seen.add(e.address);
    if (typeof e.percent !== "number" || !Number.isFinite(e.percent) || e.percent < 0 || e.percent > 100 || Math.round(e.percent * 100) !== e.percent * 100) throw new FriendsError(`Prozent bei ${name}: 0 bis 100, hoechstens zwei Nachkommastellen`);
    sum += e.percent;
    return { name, address: e.address, percent: e.percent };
  });
  if (Math.round(sum * 100) > 10000) throw new FriendsError("Die Prozente ergeben zusammen mehr als 100");
  const inviter = x.inviter ?? null;
  if (inviter !== null && (typeof inviter !== "string" || !ADDRESS_RE.test(inviter) || inviter === ownAddress)) throw new FriendsError("Ungueltiger Einlader");
  if (typeof (x.shareEnabled ?? false) !== "boolean") throw new FriendsError("shareEnabled muss true oder false sein");
  return { friends, inviter, shareEnabled: x.shareEnabled ?? false };
}

const file = (home: string) => join(home, "friends.json");

export function loadFriends(home: string, ownAddress: string | null = null): FriendsFile {
  if (!existsSync(file(home))) return { ...EMPTY, friends: [] };
  try {
    return validateFriends(JSON.parse(readFileSync(file(home), "utf8")), ownAddress);
  } catch {
    return { ...EMPTY, friends: [] };
  }
}

export function saveFriends(home: string, f: FriendsFile): void {
  const tmp = file(home) + ".tmp";
  writeFileSync(tmp, JSON.stringify(f, null, 2));
  renameSync(tmp, file(home));
}

export function rulesOf(f: FriendsFile): Rule[] {
  return f.friends.filter((x) => x.percent > 0).map((x) => ({ to: x.address, percent: x.percent }));
}

const ANIMALS = [
  "otter",
  "raven",
  "fox",
  "lynx",
  "hare",
  "bison",
  "ibex",
  "tapir",
  "stoat",
  "marten",
  "heron",
  "vole",
  "newt",
  "moth",
  "skua",
  "gecko",
  "crane",
  "tern",
  "kite",
  "merlin",
  "wren",
  "shrike",
];
const ADJECTIVES = [
  "quiet",
  "swift",
  "bright",
  "amber",
  "still",
  "wild",
  "soft",
  "spry",
  "keen",
  "gentle",
  "fern",
  "sage",
  "olive",
  "rust",
  "indigo",
  "saffron",
];
const HUES = [12, 32, 52, 92, 132, 172, 202, 232, 262, 292, 322];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export type LocalUser = {
  id: string;
  name: string;
  color: string;
};

export function makeLocalUser(): LocalUser {
  const id = crypto.randomUUID();
  return {
    id,
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: `hsl(${pick(HUES)} 70% 55%)`,
  };
}

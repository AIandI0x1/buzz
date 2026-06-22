import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveImportedPersonaAvatarUrl,
  toGooseAppAvatarRef,
} from "./gooseAppAvatarRefs.ts";

test("toGooseAppAvatarRef canonicalizes app-avatar refs", () => {
  assert.equal(
    toGooseAppAvatarRef("app-avatar:gloopies-19"),
    "app-avatar:gloopies-19",
  );
});

test("toGooseAppAvatarRef ignores Goose-looking paths by default", () => {
  assert.equal(toGooseAppAvatarRef("./avatars/pollies_2.png"), null);
});

test("toGooseAppAvatarRef detects Goose avatar ids in paths during import", () => {
  assert.equal(
    toGooseAppAvatarRef("./avatars/pollies_2.png", {
      allowFilenameFallback: true,
    }),
    "app-avatar:pollies-2",
  );
});

test("resolveImportedPersonaAvatarUrl prefers app-avatar refs over data URLs", () => {
  assert.equal(
    resolveImportedPersonaAvatarUrl({
      avatarDataUrl: "https://example.com/avatar.png",
      avatarRef: "app-avatar:fuzzies-1",
    }),
    "app-avatar:fuzzies-1",
  );
});

test("resolveImportedPersonaAvatarUrl preserves ordinary image URLs", () => {
  assert.equal(
    resolveImportedPersonaAvatarUrl({
      avatarDataUrl: "https://example.com/avatar.png",
      avatarRef: null,
    }),
    "https://example.com/avatar.png",
  );
});

test("resolveImportedPersonaAvatarUrl does not rewrite Goose-looking remote URLs", () => {
  assert.equal(
    resolveImportedPersonaAvatarUrl({
      avatarDataUrl: "https://cdn.example.com/avatars/pollies_2.png",
      avatarRef: null,
    }),
    "https://cdn.example.com/avatars/pollies_2.png",
  );
});

test("resolveImportedPersonaAvatarUrl preserves URL avatar refs", () => {
  assert.equal(
    resolveImportedPersonaAvatarUrl({
      avatarDataUrl: null,
      avatarRef: " https://example.com/persona-avatar.png ",
    }),
    "https://example.com/persona-avatar.png",
  );
});

test("resolveImportedPersonaAvatarUrl preserves Goose-looking URL avatar refs", () => {
  assert.equal(
    resolveImportedPersonaAvatarUrl({
      avatarDataUrl: null,
      avatarRef: " https://cdn.example.com/avatars/pollies_2.png ",
    }),
    "https://cdn.example.com/avatars/pollies_2.png",
  );
});

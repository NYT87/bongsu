import { describe, expect, it } from "vitest";
import { checkFolderName, FolderError, folderSlug, mediaPath } from "../src/media/folders";

describe("mediaPath", () => {
  it("joins a folder and what's inside it", () => {
    expect(mediaPath("UPLOADS", "inbox")).toBe("UPLOADS/inbox");
    expect(mediaPath("demo-studio")).toBe("demo-studio");
    expect(mediaPath("demo-studio", "/inbox")).toBe("demo-studio/inbox");
  });
});

describe("folderSlug", () => {
  it("lowercases and turns spaces into dashes", () => {
    expect(folderSlug("Demo Studio")).toBe("demo-studio");
  });
  it("keeps only allowed characters", () => {
    expect(folderSlug("Ünïcode / x")).toMatch(/^[a-z0-9_-]+$/);
    expect(folderSlug("Ünïcode / x")).toBe("ncode--x");
  });
  it("falls back to workspace", () => {
    expect(folderSlug("///")).toBe("workspace");
  });
  it("cuts to 60", () => {
    expect(folderSlug("a".repeat(80))).toHaveLength(60);
  });
});

describe("checkFolderName", () => {
  it("refuses what can't be a folder", () => {
    for (const n of ["", "  ", ".", "..", "a/b", "a".repeat(61)]) expect(() => checkFolderName(n)).toThrow(FolderError);
  });
  it("accepts and trims a good name", () => {
    expect(checkFolderName("Client A_2")).toBe("Client A_2");
    expect(checkFolderName("  UPLOADS ")).toBe("UPLOADS");
  });
});

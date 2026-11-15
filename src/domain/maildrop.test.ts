import { describe, expect, it } from "vitest";
import { blobKey } from "../storage/types.js";
import { createTestEnv } from "./testkit.js";

const source = { accountId: "u1", emailId: "M1" };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("Mail Drop items", () => {
  it("adds the item with its attachments at the end of the inbox", async () => {
    const { domain, blobStore } = createTestEnv();
    const first = domain.createTask({ name: "already here" });
    const item = await domain.createMailDropItem({
      source,
      name: "Call the plumber",
      note: "About the leak",
      attachments: [
        { name: "quote.pdf", bytes: new TextEncoder().encode("%PDF-1.4 quote"), contentType: "application/pdf" },
        { name: "photo.png", bytes: png, contentType: "application/octet-stream" },
      ],
    });
    expect(item).toMatchObject({ name: "Call the plumber", note: "About the leak", inInbox: true, parentId: null });
    expect(domain.listTasks({ inbox: true }).items.map((t) => t.id)).toEqual([first.id, item!.id]);
    const attachments = domain.listAttachments(item!.id);
    expect(attachments.map((a) => [a.name, a.contentType, a.size])).toEqual([
      ["quote.pdf", "application/pdf", 14],
      ["photo.png", "image/png", png.byteLength],
    ]);
    expect(await blobStore.get(blobKey(attachments[1]!.sha256))).toEqual(png);
  });

  it("creates one item per message, however often the message is delivered", async () => {
    const { domain } = createTestEnv();
    const input = { source, name: "Once", note: "", attachments: [] };
    const item = await domain.createMailDropItem(input);
    expect(item).not.toBeNull();
    expect(await domain.createMailDropItem(input)).toBeNull();
    expect(await domain.createMailDropItem({ ...input, source: { accountId: "u2", emailId: "M1" } })).not.toBeNull();
    expect(domain.listTasks({ inbox: true }).items.map((t) => t.name)).toEqual(["Once", "Once"]);
    expect(domain.isMailDropProcessed(source)).toBe(true);
    expect(domain.isMailDropProcessed({ accountId: "u1", emailId: "M2" })).toBe(false);
  });

  it("stays out of the undo history, so Undo still reverts the user's own last change", async () => {
    const { domain } = createTestEnv();
    const mine = domain.createTask({ name: "mine" });
    domain.updateTask(mine.id, { flagged: true });
    domain.undo();
    const item = await domain.createMailDropItem({ source, name: "From mail", note: "", attachments: [{ name: "a.txt", bytes: new TextEncoder().encode("hi") }] });
    expect(domain.history()).toMatchObject({ canUndo: true, canRedo: true, undoLabel: "Add Action", redoLabel: "Edit Action" });
    domain.redo();
    expect(domain.getTask(mine.id).flagged).toBe(true);
    domain.undo();
    domain.undo();
    expect(() => domain.getTask(mine.id)).toThrow(/not found/);
    expect(domain.getTask(item!.id).name).toBe("From mail");
    expect(domain.listAttachments(item!.id)).toHaveLength(1);
  });

  it("does not recreate an item the user deleted, and undoing the delete restores its attachment", async () => {
    const { domain, blobStore } = createTestEnv();
    const item = await domain.createMailDropItem({ source, name: "x", note: "", attachments: [{ name: "p.png", bytes: png }] });
    const [attachment] = domain.listAttachments(item!.id);
    await domain.deleteTask(item!.id);
    domain.undo();
    expect(domain.getTask(item!.id).name).toBe("x");
    expect(await domain.createMailDropItem({ source, name: "x", note: "", attachments: [] })).toBeNull();
    expect(await blobStore.get(blobKey(attachment!.sha256))).toEqual(png);
  });

  it("rejects attachments over 100 MB without creating anything", async () => {
    const { domain } = createTestEnv();
    await expect(
      domain.createMailDropItem({ source, name: "big", note: "", attachments: [{ name: "big.bin", bytes: new Uint8Array(100 * 1024 * 1024 + 1) }] }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
    expect(domain.listTasks({ inbox: true }).items).toEqual([]);
    expect(domain.isMailDropProcessed(source)).toBe(false);
  });
});

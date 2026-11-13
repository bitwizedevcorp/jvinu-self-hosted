/** Only report a copy that actually happened. */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    if (typeof text !== "string" && typeof ClipboardItem !== "undefined") {
      // Safari drops the click's permission across an await; a promised item keeps it.
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

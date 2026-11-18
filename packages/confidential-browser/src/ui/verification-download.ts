/** Keep the latest public report available until it is replaced or the page closes. */
export function verificationDownload(status: HTMLElement, retry: HTMLAnchorElement, record: () => unknown) {
  let currentUrl: string | undefined;
  const requested = () => {
    status.hidden = false;
    status.textContent = "Download requested. Check your browser’s Downloads for nebula-verification.json. If it did not appear, use “Download this record again” below.";
  };
  retry.addEventListener("click", requested);
  return () => {
    try {
      const nextUrl = URL.createObjectURL(new Blob([JSON.stringify(record(), null, 2)], { type: "application/json" }));
      const previousUrl = currentUrl;
      retry.href = nextUrl;
      retry.download = "nebula-verification.json";
      retry.hidden = false;
      currentUrl = nextUrl;
      // Install the new connected link before retiring the previous snapshot.
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      requested();
      retry.click();
    } catch {
      status.hidden = false;
      status.textContent = currentUrl
        ? "Could not complete the new download request. Use the retry link for the last successfully prepared record, or try the button again for a new snapshot."
        : "Could not prepare the verification record. Try “Download verification record” again. Your deployment has not been changed.";
    }
  };
}

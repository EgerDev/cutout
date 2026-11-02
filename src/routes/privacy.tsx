import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DocPage, DocSection } from "@/features/site/doc-page";
import { docHead } from "@/features/site/doc-head";
import { SITE_CONTACT, SITE_OPERATOR } from "@/lib/brand";

export const Route = createFileRoute("/privacy")({
  head: () =>
    docHead(
      "Privacy",
      "What Cutout does with your images, what this site's server and Hugging Face can see when you use it, and what is stored in your browser.",
    ),
  component: Privacy,
});

const REPO = "https://github.com/EgerDev/cutout";

function A({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href}>{children}</a>;
}

function Privacy() {
  return (
    <DocPage
      title="Privacy"
      subtitle="What happens to your images, which servers see what when you use Cutout, and what stays in your browser. Effective 23 September 2026."
    >
      <DocSection title="Your images">
        <p>
          Cutout opens, processes and edits your images inside your browser. They are not uploaded
          to this site&apos;s server or to anyone else. The background-removal and other models run
          on your device, using WebGPU or WebAssembly.
        </p>
        <p>
          Cutout has no accounts, cookies, analytics, advertising or tracking scripts. When you
          close or reload the tab, your images and edits are gone unless you saved the workspace
          (see below).
        </p>
      </DocSection>

      <DocSection title="What this site's server records">
        <p>
          Like most websites, the web server writes a line to an access log for every page and file
          your browser requests. Each line contains your IP address, the time, the full address
          requested (including anything after the <code>?</code>, such as a <code>?src=</code> image
          link or a <code>name=</code> file name), and request headers such as your browser&apos;s
          user agent, language and the page you came from. It never contains your images.
        </p>
        <p>
          The log is used to run the site and to investigate faults and abuse. It is not combined
          with other data or shared. Old entries are deleted by size, not by date: the server keeps
          at most about 30 MB of log (three files of 10 MB), and the oldest file is discarded when a
          new one starts. How long an entry survives therefore depends on how busy the site is.
        </p>
      </DocSection>

      <DocSection title="Other services your browser contacts">
        <p>
          <strong>Hugging Face (model downloads).</strong> The first time you remove a background,
          enhance or blur by depth, or when you download a model ahead of time under{" "}
          <em>On-device models</em>, your browser fetches that model&apos;s files from Hugging Face
          (huggingface.co and its content delivery network), operated by Hugging Face, Inc. in the
          United States. Like any web request, this gives Hugging Face your IP address, your
          browser&apos;s user agent and the address of this site. It does not include your images.
          The files are then kept in your browser, so later uses normally do not contact Hugging
          Face again. See{" "}
          <A href="https://huggingface.co/privacy">Hugging Face&apos;s privacy policy</A>.
        </p>
        <p>
          <strong>Image links.</strong> A link to Cutout can name an image on another website with{" "}
          <code>?src=</code>. Cutout shows you that website&apos;s name and asks before loading
          anything from it. If you agree, your browser fetches the image directly from that website,
          which then receives your IP address, your browser&apos;s user agent and the address of
          this site. No cookies are sent with that request.
        </p>
        <p>
          <strong>Google Maps.</strong> If a photo contains GPS coordinates, the Info panel shows
          them with a map link. Only if you click that link does your browser open Google Maps with
          those coordinates in the address, which Google then receives along with your IP address.
        </p>
        <p>
          <strong>Sharing.</strong> If you use Share, the file goes to the app or contact you pick
          in your device&apos;s share sheet.
        </p>
      </DocSection>

      <DocSection title="What is stored in your browser">
        <p>Nothing below is sent anywhere. It stays in this browser on this device.</p>
        <ul>
          <li>
            <strong>Saved workspace</strong>, only if you choose to save it (the{" "}
            <em>Save workspace</em> button in the header). Once you turn on{" "}
            <em>Enable local autosave</em> in that dialog, the saved copy is updated shortly after
            every change, including images you open later, until you pause autosave, delete the
            saved workspace or close the tab. It holds your original files exactly as you opened
            them, including any metadata inside them such as GPS location, camera details and dates,
            plus file names, results, background images and settings, up to 250 MB. It is stored in
            an IndexedDB database named <code>cutout-workspace</code>, which is not created until
            you save, and a <code>cutout.saved</code> marker in local storage.
          </li>
          <li>
            <strong>Downloaded models</strong>, in the browser&apos;s cache (
            <code>transformers-cache</code>), so they are not downloaded again.
          </li>
          <li>
            <strong>Enhance timings</strong> (<code>cutout.enhance.tileMs</code> in local storage):
            how long enhancing took on this device, used to estimate the next run.
          </li>
          <li>
            <strong>A WebGPU note</strong> (<code>cutout:removal-webgpu-failure:v1</code> in local
            storage): if WebGPU fails on this device, Cutout saves the kind of failure and the
            version of its removal runtime and models (no personal data), so the next visit skips
            WebGPU and uses WebAssembly instead. Older versions stored your browser&apos;s user
            agent under <code>bg0:webgpu-failure:…</code>; Cutout still honours those and removes
            them when you clear local workspace data.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Deleting it">
        <p>
          Open <em>Saved workspace</em> in the header and choose <em>Delete saved workspace</em> (or{" "}
          <em>Clear local workspace data</em> when nothing is saved). This deletes the whole{" "}
          <code>cutout-workspace</code> database and the <code>cutout.saved</code>, enhance-timing
          and WebGPU entries in local storage. A random deletion receipt remains so other open tabs
          cannot restore a deleted copy through a delayed autosave. It contains no images or
          settings.
        </p>
        <p>
          Downloaded models are kept, because they contain nothing about you. Remove them one by one
          under <em>On-device models</em>, or remove everything this site stored by clearing its
          data in your browser&apos;s settings.
        </p>
      </DocSection>

      <DocSection title="Metadata in your photos">
        <p>
          Photos often carry hidden details such as where and when they were taken and which device
          took them. The images Cutout exports are newly encoded and do not copy the original&apos;s
          metadata.
        </p>
        <p>
          With <em>Strip metadata</em> on, <em>Download original, cleaned</em> gives you the
          original photo without its metadata. PNG, JPEG and WebP files keep their original pixels;
          other formats are converted to PNG (very large ones are scaled down to what this device
          can re-encode, and Cutout tells you when that happens). If Cutout cannot remove the
          metadata from a file, it tells you and saves nothing.
        </p>
      </DocSection>

      <DocSection title="Who runs this site and how to reach us">
        <p>
          This site is run by {SITE_OPERATOR || "the person or organisation hosting it"}.
          Cutout&apos;s source code is public at <A href={REPO}>github.com/EgerDev/cutout</A>, so
          you can check what it does.
        </p>
        {SITE_CONTACT ? (
          <p>
            For questions about privacy, including questions about access-log entries that concern
            you, write to <A href={`mailto:${SITE_CONTACT}`}>{SITE_CONTACT}</A>.
          </p>
        ) : null}
        <p>
          For questions about the Cutout software, open an issue at{" "}
          <A href={`${REPO}/issues`}>github.com/EgerDev/cutout/issues</A>. Issues are public:
          describe your question without posting personal details there. To report a security
          problem in the software privately, use{" "}
          <A href={`${REPO}/security/advisories/new`}>GitHub private vulnerability reporting</A>.
        </p>
        <p>
          If this page changes, the date at the top changes too, and every earlier version is in the
          repository&apos;s history.
        </p>
      </DocSection>
    </DocPage>
  );
}

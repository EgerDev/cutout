import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DocPage, DocSection } from "@/features/site/doc-page";
import { docHead } from "@/features/site/doc-head";
import { SITE_CONTACT, SITE_OPERATOR } from "@/lib/brand";
import { Scale, CheckCircle2, Ban, AlertCircle, Sliders, RefreshCw, Mail } from "lucide-react";

export const Route = createFileRoute("/terms")({
  head: () =>
    docHead(
      "Terms of Use",
      "The terms for using the Cutout website: your images, acceptable use, the software licence, limits, and the absence of warranties.",
    ),
  component: Terms,
});

const REPO = "https://github.com/EgerDev/cutout";

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-accent underline underline-offset-2" href={href}>
      {children}
    </a>
  );
}

function Terms() {
  return (
    <DocPage
      title="Terms of Use"
      subtitle={`The terms for using this website, run by ${SITE_OPERATOR || "its operator"}. By using it you agree to them. Effective 23 September 2026.`}
      badge="Terms"
    >
      <DocSection title="Your images and results" icon={<CheckCircle2 className="size-5" />}>
        <p>
          Cutout does not claim any rights in the images you open or in what you make with them.
          Your images are processed in your browser and are not sent to us (see{" "}
          <Link className="text-accent underline underline-offset-2" to="/privacy">
            Privacy
          </Link>
          ).
        </p>
        <p>
          You are responsible for having the rights to the images you edit and for how you use the
          results. Some features use machine-learning models published by others under their own
          terms, listed on the{" "}
          <Link className="text-accent underline underline-offset-2" to="/licenses">
            Licenses
          </Link>{" "}
          page.
        </p>
      </DocSection>

      <DocSection title="Acceptable use" icon={<Ban className="size-5" />}>
        <p>Do not use this site to:</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>edit images you have no right to use, or make content that breaks the law;</li>
          <li>harass, deceive or impersonate people, for example with manipulated photos;</li>
          <li>
            overload, probe or disrupt the server, or send it large volumes of automated requests.
          </li>
        </ul>
        <p>
          Found a security problem? Report it privately as described in{" "}
          <A href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</A> rather than testing it against
          this site.
        </p>
      </DocSection>

      <DocSection title="The software" icon={<Scale className="size-5" />}>
        <p>
          Cutout is open-source software. Its source code is available at{" "}
          <A href={REPO}>github.com/EgerDev/cutout</A>. Original application code is under the MIT
          License; third-party components and models keep their own licenses, listed on the{" "}
          <Link className="text-accent underline underline-offset-2" to="/licenses">
            Licenses
          </Link>{" "}
          page. These terms cover your use of this website.
        </p>
      </DocSection>

      <DocSection
        title="No warranty and limitation of liability"
        icon={<AlertCircle className="size-5" />}
      >
        <p>
          This site and the software are provided &ldquo;as is&rdquo;, without warranties of any
          kind, express or implied, including fitness for a particular purpose, accuracy and
          availability.
        </p>
        <p>
          Background removal and the other features are automatic and can make mistakes: edges may
          be imperfect, parts of a subject may be removed or kept by mistake, and enhanced images
          contain detail the model invented. Check results before you print or publish them; the
          inspection view (<kbd className="keycap">M</kbd>) helps.
        </p>
        <p>
          Work that is not downloaded or saved is lost when the tab closes, and your browser may
          clear saved workspaces and models. Keep copies of anything important.
        </p>
        <p>
          To the extent the law allows, {SITE_OPERATOR || "the operator of this website"} is not
          liable for any loss or damage arising from your use of this site or the software,
          including lost work, lost data and lost profits.
        </p>
      </DocSection>

      <DocSection title="Limits" icon={<Sliders className="size-5" />}>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Up to 15 images at a time.</li>
          <li>
            Very large images are scaled down to what your device can process: up to about 96
            megapixels and 16,384 pixels on the longest side on a computer, less on phones and on
            devices with little memory.
          </li>
          <li>A custom export size can be up to 4,096 pixels wide or high.</li>
          <li>A saved workspace can hold up to 250 MB; a ZIP download up to 200 MB.</li>
          <li>
            With a target file size, Cutout first lowers the compression quality (for JPEG, WebP,
            AVIF and HEIC) and then the dimensions until the file fits. PNG is lossless compression,
            but resizing, framing or a size target changes the pixels.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Changes and availability" icon={<RefreshCw className="size-5" />}>
        <p>
          The site may change, be unavailable or stop at any time, and features depend on your
          browser and on model downloads from Hugging Face. These terms may change; the date at the
          top shows the current version, and earlier versions are in the repository&apos;s history.
          Continuing to use the site after a change means you accept the new terms.
        </p>
      </DocSection>

      <DocSection title="Contact" icon={<Mail className="size-5" />}>
        <p>
          Questions about these terms:{" "}
          {SITE_CONTACT ? (
            <A href={`mailto:${SITE_CONTACT}`}>{SITE_CONTACT}</A>
          ) : (
            <>
              open an issue at <A href={`${REPO}/issues`}>github.com/EgerDev/cutout/issues</A>
            </>
          )}
          . Security problems in the software:{" "}
          <A href={`${REPO}/security/advisories/new`}>report privately on GitHub</A>.
        </p>
      </DocSection>
    </DocPage>
  );
}

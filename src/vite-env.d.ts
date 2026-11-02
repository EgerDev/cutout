interface ImportMetaEnv {
  /** Model mirror, e.g. https://models.example.com/ (default: https://huggingface.co/). */
  readonly VITE_MODEL_HOST?: string;
  /** Who runs this copy, named on the Privacy and Terms pages (default: nobody named). */
  readonly VITE_SITE_OPERATOR?: string;
  /** A private contact for this copy, e.g. privacy@example.com (default: none). */
  readonly VITE_SITE_CONTACT?: string;
}

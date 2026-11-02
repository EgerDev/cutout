import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { StatusPage } from "./error-component";

export function AppNotFoundComponent() {
  return (
    <StatusPage
      icon={SearchX}
      title="Page not found"
      body="This page doesn’t exist or has moved."
      action={
        <>
          <Link to="/" className="status-action is-primary">
            Back to Cutout
          </Link>
          <Link to="/guide" className="status-action">
            Open the guide
          </Link>
        </>
      }
    />
  );
}

import { Fragment } from "react";
import "./TextbookHint.css";

export function TextbookHint({ text }: { text?: string }) {
  if (!text) return null;

  return (
    <p className="textbook-hint">
      <strong className="textbook-hint-label">教材语境</strong>
      {text.split("〔　〕").map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <strong className="textbook-hint-blank">（　）</strong>}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

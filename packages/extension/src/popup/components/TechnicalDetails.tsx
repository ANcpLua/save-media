interface Props {
  readonly body: string;
  readonly details: string;
}

export function TechnicalDetails({ body, details }: Props) {
  return (
    <details className="text-muted mt-1">
      <summary className="cursor-pointer">Technical details</summary>
      <p className="mt-1">{body}</p>
      <p className="mt-1 break-all">{details}</p>
    </details>
  );
}

"use client";

// /patient/[id]/qr — enroll UI: the QR the patient scans at triage to open their thread.
// Shown on the triage/desk screen; scanning opens /patient/[id] on the patient's phone.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";

export default function PatientQr() {
  const { id } = useParams<{ id: string }>();
  const [url, setUrl] = useState("");

  useEffect(() => {
    setUrl(`${window.location.origin}/patient/${id}`);
  }, [id]);

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-6 bg-white p-8 text-black">
      <h1 className="text-xl font-semibold">Scan to start check-ins</h1>
      {url && <QRCodeSVG value={url} size={256} marginSize={2} />}
      <p className="max-w-xs text-center text-sm text-gray-500">
        VIGIL will text short questions while you wait, so the care team can see how you&apos;re
        doing.
      </p>
      {url && <code className="text-xs text-gray-400">{url}</code>}
    </div>
  );
}

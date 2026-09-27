// Estado do QR Code do WhatsApp, compartilhado entre o bot e o endpoint /qr.
// (Módulo próprio para evitar import circular index ↔ bot.)
let qrCodeString: string | null = null;

export function setQrCode(qr: string | null): void {
  qrCodeString = qr;
}

export function getQrCode(): string | null {
  return qrCodeString;
}

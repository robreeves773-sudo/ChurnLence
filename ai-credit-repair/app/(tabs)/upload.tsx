import { StagePlaceholder } from '../../src/components/StagePlaceholder';

export default function UploadScreen() {
  return (
    <StagePlaceholder
      emoji="📤"
      title="Upload credit reports"
      description="Pick screenshots or photos from your library, snap a new photo, or choose official bureau PDFs. Images are downscaled and optionally redacted before AI extraction."
      stage="Stage 2"
    />
  );
}

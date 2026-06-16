import { StagePlaceholder } from '../../src/components/StagePlaceholder';

export default function ReviewScreen() {
  return (
    <StagePlaceholder
      emoji="✅"
      title="Human review"
      description="Every extracted item is shown beside its source image so you can confirm each field before anything proceeds to advice or letters. Low-confidence fields are highlighted."
      stage="Stage 2"
    />
  );
}

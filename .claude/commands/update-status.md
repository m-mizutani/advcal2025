# status.yml の更新

articles 以下のmarkdownの全ファイルから進捗状況を調査し、 `status.yml` ファイルに状況を反映してください。

- slugとmarkdownファイル名が一致します
- タイトルが更新されていたらmarkdown側を正としてyml側を更新してください
- 文章量や各節が埋まっているかを確認しておおよその進捗状況を推定し、 `progress` を 0-100 で表現してください
  - headingだけでなく本文も書き始めていたら1%以上にしてください。headingだけの場合は0%とみなしてください
  - 1%以上になったら `in_progress` にします
- 各記事の状況を1センテンスで `notes` にまとめてください
- メタデータの `published: true` となっていたら執筆完了とみなします
  - `status` は `completed` にしてください
  - `progress` は `100` に
  - `completed_date` に当日の日付を入れてください

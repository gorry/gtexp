# タイムラインのエクスポートファイルの形式

Android 端末の「設定 → 位置情報 → 位置情報サービス → タイムライン → タイムライン データをエクスポート」で作られる JSON ファイルの形式。
Google の公式な仕様書はないので、実際のファイルから読み取ったもの。

- タイムラインは端末内に暗号化して保存され、Takeout からは取れない。ほかのアプリから読む API もない
- 以前の Takeout の `Records.json` / `Semantic Location History` とは別の形式
- 毎回、その端末にある**全期間**が入る（長く使っていると 100MB を超える）

## 全体

```json
{
  "semanticSegments": [ ... ],     // 整理済みの履歴（全期間）
  "rawSignals": [ ... ],           // 生のセンサー記録（直近1か月ほど）
  "userLocationProfile": { ... }   // Google が推定したプロフィール
}
```

## 共通の書き方
- 時刻：`"2024-05-25T16:41:54.000+09:00"` のように、その土地の時差付きの文字列
- 緯度経度：`"35.681236°, 139.767125°"` のように、度記号付きの**文字列**。使うときに分解が必要
- 場所：`placeId`（Google の場所 ID）だけで、店名や住所は入っていない
  - `ChIJAAAAAAAAAAAR` で始まる placeId は自宅などの非公開の場所で、Google マップでは開けない

## semanticSegments
各要素は `startTime` / `endTime` を持ち、次のどれか1つを持つ。時差の分数（`startTimeTimezoneUtcOffsetMinutes` / `endTimeTimezoneUtcOffsetMinutes`）は `timelinePath` 以外にある。

### visit（滞在）
```json
"visit": {
  "hierarchyLevel": 0,
  "probability": 0.67,
  "isTimelessVisit": false,          // まれに出る
  "topCandidate": {
    "placeId": "ChIJ...",
    "semanticType": "UNKNOWN",
    "probability": 0.16,
    "placeLocation": { "latLng": "35.681236°, 139.767125°" }
  }
}
```
- `hierarchyLevel`：0 が主な滞在、1 が同じ時間帯の入れ子の場所。同じ開始・終了時刻で 0 と 1 が並ぶ
- `semanticType`：UNKNOWN / HOME / WORK / ALIASED_LOCATION / SEARCHED_ADDRESS / INFERRED_WORK / INFERRED_HOME など

### activity（移動）
```json
"activity": {
  "start": { "latLng": "..." },
  "end": { "latLng": "..." },
  "distanceMeters": 975,
  "probability": 0.98,               // ないこともある
  "topCandidate": { "type": "IN_PASSENGER_VEHICLE", "probability": 0.8 },
  "parking": {                       // 車の移動の一部にある
    "location": { "latLng": "..." },
    "startTime": "..."
  }
}
```
- 移動手段：IN_PASSENGER_VEHICLE / WALKING / IN_TRAIN / IN_BUS / CYCLING / UNKNOWN_ACTIVITY_TYPE / IN_SUBWAY / MOTORCYCLING / FLYING / SKIING / IN_FERRY / IN_TRAM / RUNNING など

### timelinePath（経路の点列）
```json
"timelinePath": [ { "point": "35.681236°, 139.767125°", "time": "..." }, ... ]
```
- 別のセグメントと同じ点（時刻・座標とも同じ）が重複して出ることがあるので、取り込むときに重複を除く

### timelineMemory（旅行のまとめ）
```json
"timelineMemory": {
  "trip": {
    "distanceFromOriginKms": 850,
    "destinations": [ { "identifier": { "placeId": "ChIJ..." } }, ... ]
  }
}
```

## rawSignals
直近1か月ほどの生データ。今のところ取り込んでいない（元ファイルはサーバーに保存している）。

- `position`：`LatLng`（キー名の大文字に注意）、`accuracyMeters`、`altitudeMeters`、`speedMetersPerSecond`、`source`（WIFI / WIFI_ONLY / GPS / CELL / UNKNOWN）、`timestamp`
- `wifiScan`：`deliveryTime`、`devicesRecords`（`mac` は数値、`rawRssi`）
- `activityRecord`：`probableActivities`（`type` と `confidence`）、`timestamp`

## userLocationProfile
- `frequentPlaces`：よく行く場所の上位10か所（`placeId`、`placeLocation`、自宅には `label: "HOME"`）
- `persona.travelModeAffinities`：移動手段ごとの傾向（`mode` と `affinity`）

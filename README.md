# 압구정 조망 시뮬레이션

압구정 2구역 폴리곤과 한강 조망 라인을 이용해 동/타입별 수평 조망각과 층별 차폐 변화를 확인하는 정적 웹 페이지입니다.

## 파일 구성

- `index.html`: GitHub Pages 공개용 화면
- `apgujeong_2_units.geojson`: 동/타입/층수/높이 폴리곤 데이터
- `hangang_line_zone2.geojson`: 한강 조망 기준선

## 로컬 실행

```cmd
cd /d "D:\OneDrive\office work\QGIS\apgujeong-view-github"
python -m http.server 8000
```

브라우저에서 아래 주소를 엽니다.

```text
http://127.0.0.1:8000/
```

## GitHub Pages 배포

1. GitHub에서 새 저장소를 만듭니다.
2. 이 폴더의 파일을 저장소 루트에 올립니다.
3. 저장소의 `Settings > Pages`로 이동합니다.
4. `Build and deployment`에서 `Deploy from a branch`를 선택합니다.
5. Branch는 `main`, Folder는 `/root`로 설정합니다.

## V-World 인증키 주의

공개 GitHub Pages는 정적 사이트라서 브라우저에서 쓰는 V-World 키를 완전히 숨길 수 없습니다.

현재 공개용 파일은 인증키 입력칸과 버튼을 제거했고, 기본 배경은 OSM으로 동작합니다.

V-World 위성 배경을 반드시 써야 하면 V-World에서 GitHub Pages 도메인 전용 키를 새로 발급하거나 도메인 제한을 걸고, `index.html`의 `PUBLIC_VWORLD_KEY`에 그 공개용 키를 넣어야 합니다.

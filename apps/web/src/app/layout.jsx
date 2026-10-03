export const metadata = { title: '음성 전사', description: '음성 파일을 large-v3 모델로 전사하고 텍스트 결과를 확인합니다.' };

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

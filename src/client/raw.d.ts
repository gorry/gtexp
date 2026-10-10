// Vite の「?raw」付きの import（ファイルの中身を文字列として埋め込む）
declare module '*?raw' {
  const text: string;
  export default text;
}

function hello(compiler: string) {
  console.log(`Hello from ${compiler}`);
  return compiler;
}
hello('TypeScript');

export default hello;
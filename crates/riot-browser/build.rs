fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    // `[约束]` 两个二进制都要带 `$ORIGIN` rpath。cef-dll-sys 只负责链接
    // libcef.so、把它拷到 target 目录，不管运行时去哪找 —— 少了这一条，
    // 打包目录里明明有 libcef.so，进程照样以 "cannot open shared object
    // file" 起不来，除非每个调用方都记得设 LD_LIBRARY_PATH。
    println!("cargo::rustc-link-arg=-Wl,-rpath,$ORIGIN");
    // `[约束]` libcef.so 自己依赖的 nss、alsa、dbus、cups…… 留到运行时解析。
    // ld 默认要在链接期把共享库的未定义符号也找齐，于是构建机得装一整套
    // 浏览器运行时库才链得过（干净的构建镜像里报几百条 undefined reference）。
    // 这些库是部署机的事，Dockerfile 的运行层装着它们。
    println!("cargo::rustc-link-arg=-Wl,--allow-shlib-undefined");
}

#[cfg(windows)]
#[path = "../native/windows.rs"]
#[allow(dead_code)]
mod native_windows;

#[cfg(windows)]
fn main() {
    match native_windows::dump_snapshot() {
        Ok(snapshot) => match serde_json::to_string_pretty(&snapshot) {
            Ok(output) => println!("{output}"),
            Err(error) => {
                eprintln!("Could not serialize the snapshot: {error}");
                std::process::exit(1);
            }
        },
        Err(error) => {
            eprintln!("Could not scan the foreground window: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("dump_snapshot is available on Windows only");
    std::process::exit(1);
}

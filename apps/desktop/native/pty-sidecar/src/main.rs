mod platform;
mod protocol;
mod server;
mod session;

use std::io;
use std::process::ExitCode;

use server::Server;

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|panic| {
        eprintln!("[pty-sidecar] fatal panic: {panic}");
    }));

    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[pty-sidecar] fatal error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let (frames, writer) = protocol::spawn_writer(io::stdout());
    let server = Server::new(frames.clone());
    server.send_hello()?;

    let protocol_result = server.run(io::stdin().lock());
    server.shutdown();
    drop(server);
    drop(frames);

    let writer_result = writer
        .join()
        .map_err(|_| io::Error::other("protocol writer thread panicked"))?;
    protocol_result?;
    writer_result?;
    Ok(())
}

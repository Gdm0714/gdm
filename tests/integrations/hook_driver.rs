// Oracle replay driver only. Deterministic clock is never a production CLI flag.
fn main(){use std::io::Read;let args:Vec<_>=std::env::args().collect();let cwd=std::path::Path::new(&args[1]);let timestamp=args[2].parse().unwrap();let mut input=String::new();std::io::stdin().read_to_string(&mut input).unwrap();println!("{}",gdm::integrations::agent::run_hook_at(cwd,&input,timestamp));}

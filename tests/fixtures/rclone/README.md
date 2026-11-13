Made by rclone v1.75.2 (`rclone/rclone:1.75`) with a crypt remote:
`password = correct horse battery staple` (no salt), `filename_encryption = off`,
`directory_name_encryption = false`. Plaintexts: `hello.txt` = "hello from rclone\n",
`empty.txt` = empty, `pattern.bin` = 70,000 bytes where byte i = (i × 31) mod 251.
tests/crypt.test.ts decrypts them, proving jvinu reads what rclone writes.

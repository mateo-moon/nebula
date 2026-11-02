packer {
  required_plugins {
    amazon = { version = "= 1.3.9", source = "github.com/hashicorp/amazon" }
  }
}
variable "input_file" {
  type = string
  validation {
    condition     = try(jsondecode(file(var.input_file)).spending.enabled == true && length(trimspace(jsondecode(file(var.input_file)).spending.approvalReference)) > 0, false)
    error_message = "Image builds are disabled until the catalog's cost approval is recorded."
  }
}
variable "output_dir" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_id" { type = string }
locals { input = jsondecode(file(var.input_file)) }
source "amazon-ebs" "debian" {
  region                                    = local.input.region
  source_ami                                = local.input.sourceAmi
  instance_type                             = local.input.architecture == "arm64" ? "m6g.large" : "c6a.large"
  vpc_id                                    = var.vpc_id
  subnet_id                                 = var.public_subnet_id
  associate_public_ip_address               = true
  ssh_username                              = local.input.sshUser
  ssh_interface                             = "public_ip"
  ssh_clear_authorized_keys                 = true
  temporary_security_group_source_public_ip = true
  ami_name                                  = "nebula-debian-13-${local.input.architecture}-{{timestamp}}"
  launch_block_device_mappings {
    device_name           = local.input.rootDeviceName
    volume_size           = 40
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }
  tags     = { Name = "nebula-debian-base", "image-family" = "debian-${local.input.architecture}", "parent-ami" = local.input.sourceAmi }
  run_tags = { Name = "nebula-debian-base-builder" }
}
build {
  sources = ["source.amazon-ebs.debian"]
  provisioner "file" {
    source      = var.input_file
    destination = "/tmp/nebula-image-plan.json"
  }
  provisioner "file" {
    source      = "${abspath(path.root)}/amazon-ssm-agent.asc"
    destination = "/tmp/amazon-ssm-agent.asc"
  }
  provisioner "shell" {
    script          = "${abspath(path.root)}/build-base.sh"
    execute_command = "chmod +x {{ .Path }}; sudo -E NEBULA_IMAGE_BUILD=1 {{ .Vars }} {{ .Path }}"
    timeout         = "30m"
  }
  post-processor "manifest" {
    output     = "${var.output_dir}/manifest.json"
    strip_path = true
  }
}

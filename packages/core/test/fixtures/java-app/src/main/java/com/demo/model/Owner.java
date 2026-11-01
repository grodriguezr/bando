package com.demo.model;

import java.util.ArrayList;
import java.util.List;

/** Un dueño de mascotas. */
public class Owner extends BaseEntity {
    private String name;
    private final List<Pet> pets = new ArrayList<>();

    public String getName() {
        return name;
    }

    public List<Pet> getPets() {
        return pets;
    }

    public Pet addPet(Pet pet) {
        pets.add(pet);
        return pet;
    }

    public Pet addPet(String name, int age) {
        return addPet(new Pet(name));
    }
}
